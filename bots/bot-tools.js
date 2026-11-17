// Bot 电脑里的"手"：接收大脑发来的工具调用（打开网页、点击、输入、执行命令、读写文件、截图……）并执行。
// 只监听容器内的 7695 端口；宿主机只把它映射到本机回环地址，再经加密隧道给调度台用。
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const { chromium } = require('playwright-core');
const ext = require('./ext-tools.js');   // 技能、MCP，以及把安装请求转交给安装器

const PORT = 7695;
const HOME = '/home/bot';
const WORK = path.join(HOME, 'work');
const PUB = path.join(HOME, 'public');   // 这个文件夹里的内容会被公开到外网（只读、静态）
const PUB_URLS = (process.env.PUBLISH_URLS || 'https://bot.example.org/b,https://bot.example.com/b').split(',');
const ENV = { ...process.env, DISPLAY: ':1', HOME, LANG: 'zh_CN.UTF-8' };
const clip = (s, n) => { s = String(s === undefined || s === null ? '' : s); return s.length > n ? s.slice(0, n) + `\n…（后面还有 ${s.length - n} 字，已省略）` : s; };
const fail = (m) => Object.assign(new Error(m), { expected: true });
const safeId = (id) => { if (!/^[a-z0-9]{4,24}$/.test(id || '')) throw fail('bot id 不对'); return id; };
const workdir = (bot) => { const d = path.join(WORK, safeId(bot)); fs.mkdirSync(d, { recursive: true }); return d; };
// 文件路径：相对路径相对于这个 Bot 的工作目录；只允许在 /home/bot 里面。
function resolveIn(bot, p) {
  const abs = path.resolve(workdir(bot), String(p || ''));
  if (abs !== HOME && !abs.startsWith(HOME + path.sep)) throw fail('只能访问 /home/bot 里面的文件');
  return abs;
}
const run = (cmd, args, opts) => new Promise((resolve) => execFile(cmd, args, { env: ENV, timeout: 20000, maxBuffer: 20 * 1024 * 1024, ...opts }, (err, out, errOut) => resolve({ err, out, errOut })));

// ---------------- 浏览器 ----------------
let browser = null;
const pages = new Map(); // 每个 Bot 一个标签页
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  for (let i = 0; i < 20; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 5000 }); pages.clear(); return browser; }
    catch (e) { await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw fail('浏览器没有启动起来');
}
async function getPage(bot) {
  const b = await getBrowser();
  let page = pages.get(bot);
  if (!page || page.isClosed()) {
    const ctx = b.contexts()[0];
    const blank = ctx.pages().find((p) => p.url() === 'about:blank' && ![...pages.values()].includes(p));
    page = blank || await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    pages.set(bot, page);
  }
  await page.bringToFront().catch(() => {});
  return page;
}
const SNAPSHOT = () => {
  document.querySelectorAll('[data-bot-idx]').forEach((e) => e.removeAttribute('data-bot-idx'));
  const els = [...document.querySelectorAll('a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[onclick],[contenteditable=true]')];
  const out = [];
  let i = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect(), st = getComputedStyle(el);
    if (r.width < 4 || r.height < 4 || st.visibility === 'hidden' || st.display === 'none' || el.disabled) continue;
    if (r.bottom < -200 || r.top > innerHeight * 2.5) continue; // 只列出当前屏幕附近的
    if (el.type === 'hidden') continue;
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.title || el.name || el.alt || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!label && el.tagName === 'A') continue;
    el.setAttribute('data-bot-idx', String(++i));
    const tag = el.tagName.toLowerCase();
    out.push(`[${i}] <${tag}${el.type && tag !== 'a' ? ' ' + el.type : ''}> ${label}${tag === 'a' ? ' → ' + el.href.slice(0, 120) : ''}`);
    if (i >= 150) break;
  }
  const text = document.body ? document.body.innerText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') : '';
  return { title: document.title, url: location.href, text, elements: out, scrollY: Math.round(scrollY), maxScroll: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)) };
};
async function snapshot(page, note) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  let s;
  try { s = await page.evaluate(SNAPSHOT); } catch (e) { await page.waitForTimeout(1200); s = await page.evaluate(SNAPSHOT); }
  return (note ? note + '\n' : '') + `网页标题：${s.title}\n网址：${s.url}\n滚动位置：${s.scrollY} / ${s.maxScroll}\n\n【页面文字】\n${clip(s.text, 6000)}\n\n【可以操作的元素】（用方括号里的编号来点击或输入）\n${s.elements.join('\n') || '（没有找到）'}`;
}
const locate = (page, index) => {
  if (!Number.isInteger(index) || index < 1) throw fail('index 要填 browser_read 列出来的编号');
  return page.locator(`[data-bot-idx="${index}"]`).first();
};
const fixUrl = (u) => { u = String(u || '').trim(); if (!u) throw fail('没有给网址');
  // 自己电脑里的网页文件也能打开（只限 /home/bot 里面），方便预览和截图自己做的页面。
  if (u.startsWith('/home/bot/')) u = 'file://' + u;
  if (/^file:\/\//i.test(u)) { const p = path.resolve(decodeURIComponent(u.replace(/^file:\/\//i, '').split(/[?#]/)[0])); if (!p.startsWith(HOME + path.sep)) throw fail('只能打开 /home/bot 里面的文件'); return 'file://' + encodeURI(p); } if (!/^[a-z]+:/i.test(u)) u = 'https://' + u; if (!/^https?:/i.test(u)) throw fail('只能打开 http/https 网址'); return u; };

// ---------------- 搜索和抓取 ----------------
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const strip = (h) => String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
async function webSearch(query) {
  query = String(query || '').trim();
  if (!query) throw fail('没有给搜索词');
  const results = [];
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(15000) });
    const html = await res.text();
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g;
    for (let m; (m = re.exec(html)) && results.length < 8;) {
      let url = m[1].replace(/&amp;/g, '&');
      const u = /[?&]uddg=([^&]+)/.exec(url);
      if (u) url = decodeURIComponent(u[1]);
      if (url.startsWith('//')) url = 'https:' + url;
      const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(m[3]);
      if (/duckduckgo\.com\/y\.js/.test(url)) continue; // 广告
      results.push({ title: strip(m[2]), url, snippet: sn ? strip(sn[1]) : '' });
    }
  } catch (e) { /* 换下一个搜索引擎 */ }
  if (!results.length) {
    try {
      const res = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(query), { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(15000) });
      const html = await res.text();
      const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
      for (let m; (m = re.exec(html)) && results.length < 8;) results.push({ title: strip(m[2]), url: m[1].replace(/&amp;/g, '&'), snippet: m[3] ? strip(m[3]) : '' });
    } catch (e) { /* 两个都不行 */ }
  }
  if (!results.length) return '没有搜到结果（搜索引擎可能暂时拒绝了请求）。可以改用 browser_open 打开 https://www.bing.com/search?q=关键词 来搜。';
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
}
async function webFetch(url) {
  const res = await fetch(fixUrl(url), { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const type = res.headers.get('content-type') || '';
  if (!/text|json|xml|javascript/.test(type)) return `这个网址返回的不是文字内容（${type || '未知类型'}，状态 ${res.status}）。要下载它可以用 shell 里的 curl -L -o 文件名 网址。`;
  const body = await res.text();
  return `状态 ${res.status} · ${res.url}\n\n` + clip(/html/.test(type) ? strip(body) : body, 9000);
}

// ---------------- 工具 ----------------
async function shot(file) { // 截整个桌面
  const png = '/tmp/desk-' + Date.now() + '.png';
  await run('scrot', ['-z', '-o', png]);   // -z：截屏不要响铃，否则每截一次，正在看远程桌面的人就听到一声叮
  const r = await run('convert', [png, '-quality', '62', 'jpg:' + file]);
  fs.rm(png, { force: true }, () => {});
  if (r.err) throw fail('截图失败');
}
const TOOLS = {
  async shell(bot, a) {
    const command = String(a.command || '');
    if (!command.trim()) throw fail('没有给命令');
    const timeout = Math.min(Math.max(Number(a.timeout) || 60, 1), 300) * 1000;
    return new Promise((resolve) => {
      const child = spawn('bash', ['-lc', command], { cwd: workdir(bot), env: ENV, detached: true });
      let out = '', done = false;
      const add = (c) => { if (out.length < 200000) out += c; };
      child.stdout.on('data', add); child.stderr.on('data', add);
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* 已经结束 */ } out += `\n[超过 ${timeout / 1000} 秒，已终止。需要长时间运行的程序请用 nohup … & 放到后台]`; }, timeout);
      child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ output: `退出码 ${code}\n` + clip(out, 12000) }); });
      child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ output: '命令没有启动起来：' + e.message }); });
    });
  },
  async write_file(bot, a) {
    const p = resolveIn(bot, a.path);
    if (typeof a.content !== 'string') throw fail('没有给 content');
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, a.content);
    return { output: `已写入 ${p}（${Buffer.byteLength(a.content)} 字节）` };
  },
  async read_file(bot, a) {
    const p = resolveIn(bot, a.path);
    const st = await fsp.stat(p).catch(() => null);
    if (!st) throw fail('文件不存在：' + p);
    if (st.isDirectory()) { const names = await fsp.readdir(p); return { output: `${p} 是文件夹，里面有：\n` + names.slice(0, 200).join('\n') }; }
    if (st.size > 5 * 1024 * 1024) throw fail('文件太大（超过 5 MB），请用 shell 里的 head / grep 看其中一部分');
    const buf = await fsp.readFile(p);
    if (buf.subarray(0, 4000).includes(0)) return { output: `${p} 不是文字文件（${st.size} 字节）。` };
    return { output: clip(buf.toString('utf8'), 12000) };
  },
  async list_files(bot, a) {
    const p = resolveIn(bot, a.path || '.');
    const names = await fsp.readdir(p, { withFileTypes: true }).catch(() => { throw fail('文件夹不存在：' + p); });
    const rows = await Promise.all(names.slice(0, 300).map(async (d) => { const st = await fsp.stat(path.join(p, d.name)).catch(() => null); return (d.isDirectory() ? '[文件夹] ' : '         ') + d.name + (st && !d.isDirectory() ? `  (${st.size} 字节)` : ''); }));
    return { output: `${p}\n` + (rows.join('\n') || '（空的）') };
  },
  async web_search(bot, a) { return { output: await webSearch(a.query) }; },
  async web_fetch(bot, a) { return { output: await webFetch(a.url) }; },
  // 用 Obscura（无界面浏览器）读一个网页：会执行页面里的脚本，比 web_fetch 看得全，比打开真浏览器快。
  async web_render(bot, a) {
    const url = fixUrl(a.url);
    if (!/^https?:/i.test(url)) throw fail('只能读 http/https 网址');
    const fmt = ['text', 'markdown', 'links', 'html'].includes(a.format) ? a.format : 'markdown';
    const stealth = a.stealth === true;
    const args = [...(stealth ? ['--stealth'] : []), 'fetch', url, '--dump', fmt, '-q', '--timeout', '40'];
    if (a.wait) args.push('--wait', String(Math.min(Math.max(Math.round(Number(a.wait)) || 1, 1), 20)));
    const r = await run(stealth ? '/opt/obscura/stealth/obscura' : '/opt/obscura/normal/obscura', args, { timeout: 75000, cwd: workdir(bot) });
    const out = String(r.out || '').trim();
    if (!out) throw fail('没有读到内容' + (r.err && r.err.killed ? '（超时）' : '') + '：' + String(r.errOut || (r.err && r.err.message) || '').trim().replace(/\s+/g, ' ').slice(-300));
    return { output: `（${stealth ? '隐身版' : '普通版'}无界面浏览器读取 ${url}，格式 ${fmt}，共 ${out.length} 字）` + String.fromCharCode(10) + clip(out, 20000) };
  },
  async browser_open(bot, a) {
    const page = await getPage(bot);
    const url = fixUrl(a.url);
    let note = '';
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { note = '（页面加载超时或出错：' + String(e.message).split('\n')[0].slice(0, 120) + '；下面是目前加载出来的内容）'; }
    return { output: await snapshot(page, note) };
  },
  async browser_read(bot) { return { output: await snapshot(await getPage(bot)) }; },
  async browser_click(bot, a) {
    const page = await getPage(bot);
    const before = page.context().pages().length;
    await locate(page, a.index).click({ timeout: 8000 }).catch(async (e) => { // 被遮住时退一步，直接触发点击
      await locate(page, a.index).evaluate((el) => el.click()).catch(() => { throw fail('点不到这个元素：' + String(e.message).split('\n')[0].slice(0, 120) + '。先用 browser_read 重新看一下页面'); });
    });
    await page.waitForTimeout(900);
    const all = page.context().pages();
    if (all.length > before) { const fresh = all[all.length - 1]; fresh.setDefaultTimeout(15000); pages.set(bot, fresh); await fresh.bringToFront().catch(() => {}); return { output: await snapshot(fresh, '（点击后打开了一个新标签页，现在看的是新标签页）') }; }
    return { output: await snapshot(page) };
  },
  async browser_type(bot, a) {
    const page = await getPage(bot);
    const el = locate(page, a.index);
    const text = String(a.text === undefined ? '' : a.text);
    await el.fill(text, { timeout: 8000 }).catch(async () => { await el.click({ timeout: 5000 }); await page.keyboard.press('Control+A'); await page.keyboard.type(text, { delay: 15 }); });
    if (a.enter) { await el.press('Enter').catch(() => page.keyboard.press('Enter')); await page.waitForTimeout(1200); }
    return { output: await snapshot(page) };
  },
  async browser_select(bot, a) {
    const page = await getPage(bot);
    await locate(page, a.index).selectOption({ label: String(a.option) }).catch(() => locate(page, a.index).selectOption(String(a.option)));
    return { output: await snapshot(page) };
  },
  async browser_key(bot, a) {
    const page = await getPage(bot);
    await page.keyboard.press(String(a.key || 'Enter'));
    await page.waitForTimeout(800);
    return { output: await snapshot(page) };
  },
  async browser_scroll(bot, a) {
    const page = await getPage(bot);
    const dir = a.direction === 'up' ? -1 : 1;
    await page.evaluate((d) => { if (d === 'top') scrollTo(0, 0); else if (d === 'bottom') scrollTo(0, document.documentElement.scrollHeight); else scrollBy(0, d * innerHeight * 0.85); }, a.direction === 'top' || a.direction === 'bottom' ? a.direction : dir);
    return { output: await snapshot(page) };
  },
  async browser_back(bot) { const page = await getPage(bot); await page.goBack({ timeout: 15000 }).catch(() => {}); return { output: await snapshot(page) }; },
  async browser_screenshot(bot) {
    const page = await getPage(bot);
    const buf = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 15000 });
    const file = path.join(workdir(bot), 'screenshots', `page-${Date.now()}.jpg`);
    await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, buf);
    return { output: `已截下当前网页（${page.url()}），保存在 ${file}`, image: buf.toString('base64'), imagePath: file };
  },
  async desktop_screenshot(bot) {
    const file = path.join(workdir(bot), 'screenshots', `desktop-${Date.now()}.jpg`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await shot(file);
    return { output: `已截下整个桌面（1440×900），保存在 ${file}。desktop_click 的坐标就是这张图上的像素位置。`, image: (await fsp.readFile(file)).toString('base64'), imagePath: file };
  },
  async desktop_click(bot, a) {
    const x = Math.round(Number(a.x)), y = Math.round(Number(a.y));
    if (!(x >= 0 && x <= 1440 && y >= 0 && y <= 900)) throw fail('坐标要在 1440×900 的屏幕范围内');
    const args = ['mousemove', String(x), String(y), 'click'];
    if (a.double) args.push('--repeat', '2');
    args.push(a.button === 'right' ? '3' : '1');
    await run('xdotool', args);
    return { output: `已在 (${x}, ${y}) ${a.double ? '双击' : a.button === 'right' ? '右键点击' : '点击'}。用 desktop_screenshot 看结果。` };
  },
  async desktop_type(bot, a) { await run('xdotool', ['type', '--delay', '20', '--', String(a.text || '')]); return { output: '已输入文字。' }; },
  async desktop_key(bot, a) {
    const key = String(a.key || '');
    if (!/^[A-Za-z0-9_+]{1,40}$/.test(key)) throw fail('按键名不对，例：Return、ctrl+a、alt+F4、Tab');
    await run('xdotool', ['key', '--', key]);
    return { output: '已按下 ' + key };
  },
  // 发布到公开网址：复制一份到 /home/bot/public/<发布名>/，电脑外面的只读网页服务会把它提供出去。
  async publish(bot, a) {
    const src = resolveIn(bot, a.path);
    const st = await fsp.stat(src).catch(() => null);
    if (!st) throw fail('找不到：' + src);
    if (src === PUB || src.startsWith(PUB + path.sep)) throw fail('它已经在发布目录里了');
    const SKIP = new Set(['node_modules', '__pycache__']);
    let bytes = 0, files = 0;
    const walk = async (p) => {
      const s = await fsp.stat(p);
      if (s.isDirectory()) { for (const n of await fsp.readdir(p)) if (!n.startsWith('.') && !SKIP.has(n)) await walk(path.join(p, n)); }
      else if (s.isFile()) { bytes += s.size; files += 1; }
      if (bytes > 500 * 1024 * 1024 || files > 5000) throw fail('内容太大了（上限 500 MB / 5000 个文件），先精简或打成压缩包');
    };
    await walk(src);
    if (!files) throw fail('里面没有可以发布的文件');
    const base = String(a.name || path.basename(src, st.isFile() ? path.extname(src) : '')).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
    const slug = base + '-' + require('crypto').randomBytes(4).toString('hex');   // 带一段随机字符，别人猜不到链接
    const dest = path.join(PUB, slug);
    await fsp.mkdir(dest, { recursive: true });
    if (st.isDirectory()) await fsp.cp(src, dest, { recursive: true, dereference: true, filter: (p) => { const n = path.basename(p); return p === src || (!n.startsWith('.') && !SKIP.has(n)); } });
    else await fsp.copyFile(src, path.join(dest, path.basename(src)));
    const open = async (p) => { const s = await fsp.stat(p); if (s.isDirectory()) { await fsp.chmod(p, 0o755); for (const n of await fsp.readdir(p)) await open(path.join(p, n)); } else await fsp.chmod(p, 0o644); };
    await open(dest);
    const tail = st.isDirectory() || /^index\.html?$/i.test(path.basename(src)) ? '' : encodeURIComponent(path.basename(src));
    const urls = PUB_URLS.map((b) => b + '/' + slug + '/' + tail);
    const hasIndex = st.isDirectory() && fs.existsSync(path.join(dest, 'index.html'));
    return { output: `已发布（${files} 个文件）。\n链接：${urls[0]}\n备用链接：${urls[1] || urls[0]}\n任何拿到链接的人都能打开，不需要登录。${st.isDirectory() && !hasIndex ? '这个文件夹里没有 index.html，链接打开是一个文件列表。' : ''}\n要撤下就删除文件夹 ${dest}`, link: { url: urls[0], alt: urls[1] || '', name: slug } };
  },
  async skill_read(bot, a) { return ext.skillRead(a); },
  async mcp_tools(bot, a) { return ext.mcpTools(a, ENV, workdir(bot)); },
  async mcp_call(bot, a) { return ext.mcpCall(a, ENV, workdir(bot)); },
  async deliver(bot, a) {
    const p = resolveIn(bot, a.path);
    const st = await fsp.stat(p).catch(() => null);
    if (!st || !st.isFile()) throw fail('文件不存在：' + p);
    return { output: `已把 ${path.basename(p)}（${st.size} 字节）交给用户，用户可以在对话里下载。`, file: { path: p, name: path.basename(p), size: st.size } };
  },
};

// ---------------- HTTP ----------------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2 * 1024 * 1024) { reject(fail('请求太大')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(fail('请求格式不对')); } });
  });
}
const send = (res, status, obj) => { const data = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) }); res.end(data); };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const b = await getBrowser().catch(() => null);
      return send(res, 200, { ok: true, browser: Boolean(b), tabs: b ? b.contexts()[0].pages().length : 0, tools: Object.keys(TOOLS) });
    }
    if (req.method === 'GET' && url.pathname === '/file') {
      const p = resolveIn(url.searchParams.get('bot'), url.searchParams.get('path'));
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isFile()) return send(res, 404, { error: '文件不存在' });
      const img = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(p).toLowerCase()];
      res.writeHead(200, { 'Content-Type': (url.searchParams.get('inline') && img) || 'application/octet-stream', 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `${url.searchParams.get('inline') && img ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(p))}` });
      return fs.createReadStream(p).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/screen') { // 桌面的一张小截图，给调度台卡片上的缩略图用
      const file = '/tmp/thumb.jpg';
      await shot(file);
      const buf = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      return res.end(buf);
    }
    if (url.pathname.startsWith('/ext/')) { if ((await ext.handle(req, res, url, readJson, send)) !== false) return; }
    if (req.method === 'POST' && url.pathname === '/tool') {
      const body = await readJson(req);
      const fn = TOOLS[body.name];
      if (!fn) return send(res, 200, { ok: false, output: `没有 ${body.name} 这个工具。可用的工具：${Object.keys(TOOLS).join('、')}` });
      try { return send(res, 200, { ok: true, ...(await fn(safeId(body.bot), body.args && typeof body.args === 'object' ? body.args : {})) }); }
      catch (e) { return send(res, 200, { ok: false, output: '工具执行失败：' + (e.expected ? e.message : String(e.message || e).split('\n')[0].slice(0, 300)) }); }
    }
    if (req.method === 'POST' && url.pathname === '/reset') { // 关掉这个 Bot 的标签页
      const body = await readJson(req);
      const page = pages.get(body.bot);
      if (page && !page.isClosed()) await page.close().catch(() => {});
      pages.delete(body.bot);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, e.expected ? 400 : 500, { error: e.expected ? e.message : '内部错误' }); if (!e.expected) console.error(e); }
}).listen(PORT, '0.0.0.0', () => console.log('bot tools listening on ' + PORT));
process.on('unhandledRejection', (e) => console.error('unhandled', e));
