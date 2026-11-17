// Bot 电脑里的"安装器"：给这台电脑加装软件包、技能和 MCP 服务。
// 它是这台电脑里唯一有管理员权限的程序。Bot 自己（普通用户 bot）装不了系统软件，也改不了这里登记的技能和 MCP；
// 只有带着口令来的请求才执行，而口令只有调度台那边的 Bot 大脑有 —— 大脑只在 CEO Agent 批准、开发者给出安装方案之后才会来调用。
// 只监听这台电脑内部的 127.0.0.1:7697。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = 7697;
const S = '/var/lib/bot-installer';                 // 挂在电脑外面的一个文件夹：重建电脑也不会丢；bot 用户只能读
const TOKEN_FILE = path.join(S, 'token');
const LIST_FILE = path.join(S, 'installed.json');
const SKILLS = path.join(S, 'skills');
const MCP_FILE = path.join(S, 'mcp.json');
const MARK = '/var/lib/.bot-installer-restored';      // 在电脑自己的磁盘上：电脑被重建后它就没了，据此知道要把软件包重装一遍

fs.mkdirSync(SKILLS, { recursive: true });
fs.chmodSync(S, 0o755);
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
fs.chmodSync(TOKEN_FILE, 0o600);
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); fs.chmodSync(f, 0o644); };
if (!fs.existsSync(MCP_FILE)) writeJson(MCP_FILE, { servers: {} });
if (!fs.existsSync(LIST_FILE)) writeJson(LIST_FILE, []);
const fail = (m) => Object.assign(new Error(m), { expected: true });

const PKG_RE = { apt: /^[a-z0-9][a-z0-9+.-]{1,60}$/, pip: /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(\[[A-Za-z0-9,_-]{1,40}\])?(==[A-Za-z0-9.]{1,20})?$/, npm: /^(@[a-z0-9][a-z0-9._-]{0,40}\/)?[a-z0-9][a-z0-9._-]{0,60}(@[A-Za-z0-9.^~-]{1,20})?$/ };
// 这些会动到这台电脑自己的根基或者往外开口子，不管谁批准都不装。
const NEVER = /^(sudo|doas|docker.*|podman.*|containerd.*|lxc.*|openssh-server|dropbear.*|telnetd|systemd.*|linux-image.*|linux-headers.*|kmod|iptables|nftables|ufw|wireguard.*|openvpn|tor|nmap|masscan|hydra|john|hashcat|aircrack.*|metasploit.*|sqlmap|xvfb|chromium.*|x11vnc|novnc|websockify|openbox|nodejs|node|python3|python3-minimal|libc6|apt|dpkg|bash|coreutils)$/i;
const ENV = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive', HOME: '/root', LANG: 'C.UTF-8', PIP_BREAK_SYSTEM_PACKAGES: '1', PIP_NO_CACHE_DIR: '1', PIP_ROOT_USER_ACTION: 'ignore', NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
const run = (cmd, args, timeout) => new Promise((resolve) => execFile(cmd, args, { env: ENV, timeout, maxBuffer: 30 * 1024 * 1024 }, (err, out, errOut) => resolve({ ok: !err, log: (String(out) + String(errOut)).trim().slice(-6000) + (err && err.killed ? '\n[超时，已终止]' : '') })));
let busy = false;

async function installPackages(method, packages) {
  if (!PKG_RE[method]) throw fail('安装方式只能是 apt、pip 或 npm');
  if (!Array.isArray(packages) || !packages.length || packages.length > 8) throw fail('要给 1 到 8 个包名');
  for (const p of packages) {
    if (typeof p !== 'string' || !PKG_RE[method].test(p)) throw fail('包名不合规：' + String(p).slice(0, 60));
    if (NEVER.test(p.replace(/[=@\[].*$/, ''))) throw fail('这个包不允许安装：' + p);
  }
  if (method === 'apt') {
    const fresh = (() => { try { return Date.now() - fs.statSync('/var/lib/apt/periodic/bot-update-stamp').mtimeMs < 12 * 3600000; } catch (e) { return false; } })();
    if (!fresh) { const u = await run('apt-get', ['update', '-q'], 180000); if (!u.ok) return { ok: false, log: '更新软件源失败：\n' + u.log }; fs.mkdirSync('/var/lib/apt/periodic', { recursive: true }); fs.writeFileSync('/var/lib/apt/periodic/bot-update-stamp', ''); }
    return run('apt-get', ['install', '-y', '-q', '--no-install-recommends', '--', ...packages], 600000);
  }
  if (method === 'pip') return run('pip3', ['install', '--no-input', '--', ...packages], 600000);
  return run('npm', ['install', '-g', '--no-fund', '--no-audit', '--', ...packages], 600000);
}
function record(entry) {
  const list = readJson(LIST_FILE, []);
  list.push({ ...entry, at: Date.now() });
  writeJson(LIST_FILE, list.slice(-300));
}

// 技能：一个文件夹，里面有 SKILL.md（开头写着名字和什么时候该用它）。
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;
function skillMeta(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch (e) { return null; }
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  const pick = (k) => { const m = fm && new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(fm[1]); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  return { description: (pick('description') || text.replace(/^---[\s\S]*?---/, '').trim().split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').slice(0, 300) };
}
async function installSkillText(name, content) {
  if (!NAME_RE.test(name || '')) throw fail('技能名只能用小写字母、数字、短横线');
  if (typeof content !== 'string' || content.trim().length < 80 || content.length > 40000) throw fail('技能内容太短或太长（80 到 40000 字）');
  const dir = path.join(SKILLS, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, { mode: 0o644 });
  return { ok: true, log: '已写入技能 ' + name + '（SKILL.md，' + content.length + ' 字）' };
}
async function gh(url, raw) {
  const res = await fetch(url, { headers: { 'User-Agent': 'bot-installer', Accept: raw ? '*/*' : 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw fail('从 GitHub 取不到（' + res.status + '）：' + url.replace(/^https:\/\/[^/]+/, '').slice(0, 120));
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}
async function installSkillRepo(name, repo, dirPath, ref) {
  if (!NAME_RE.test(name || '')) throw fail('技能名只能用小写字母、数字、短横线');
  if (!/^[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,80}$/.test(repo || '')) throw fail('仓库要写成 owner/name');
  const base = String(dirPath || '').replace(/^\/+|\/+$/g, '');
  if (base.includes('..') || !/^[A-Za-z0-9_.\/-]{0,200}$/.test(base)) throw fail('路径不合规');
  const branch = /^[A-Za-z0-9_.\/-]{1,80}$/.test(ref || '') ? ref : (await gh('https://api.github.com/repos/' + repo)).default_branch;
  const tree = await gh(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const prefix = base ? base + '/' : '';
  const files = (tree.tree || []).filter((t) => t.type === 'blob' && t.path.startsWith(prefix) && !t.path.slice(prefix.length).split('/').some((p) => p.startsWith('.')));
  if (!files.some((f) => f.path === prefix + 'SKILL.md')) throw fail('那个位置没有 SKILL.md，不是一个技能：' + repo + '/' + base);
  if (files.length > 80 || files.reduce((n, f) => n + (f.size || 0), 0) > 4 * 1024 * 1024) throw fail('这个技能太大了（上限 80 个文件 / 4 MB）');
  const dir = path.join(SKILLS, name), tmp = dir + '.new';
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const rel = f.path.slice(prefix.length), dest = path.join(tmp, rel);
    if (!dest.startsWith(tmp + path.sep)) throw fail('路径不合规');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await gh(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${f.path.split('/').map(encodeURIComponent).join('/')}`, true), { mode: 0o644 });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return { ok: true, log: `已从 ${repo}/${base || '（根目录）'} 安装技能 ${name}（${files.length} 个文件）` };
}
// MCP：登记"怎么启动这个外部工具服务"。真正启动是 Bot 用到它的时候，以普通用户身份启动。
async function installMcp(name, command, args) {
  if (!NAME_RE.test(name || '')) throw fail('MCP 名只能用小写字母、数字、短横线');
  if (!['npx', 'node', 'python3', 'uvx'].includes(command)) throw fail('启动命令只能是 npx、node、python3 或 uvx');
  if (!Array.isArray(args) || args.length > 12 || args.some((a) => typeof a !== 'string' || a.length > 200 || /[\0\n\r;|&`$<>]/.test(a))) throw fail('启动参数不合规');
  const m = readJson(MCP_FILE, { servers: {} });
  m.servers[name] = { command, args };
  writeJson(MCP_FILE, m);
  return { ok: true, log: `已登记 MCP 服务 ${name}：${command} ${args.join(' ')}` };
}
function listing() {
  const skills = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.endsWith('.new')).map((e) => ({ name: e.name, ...(skillMeta(path.join(SKILLS, e.name)) || { description: '' }) }));
  return { packages: readJson(LIST_FILE, []), skills, mcp: Object.entries(readJson(MCP_FILE, { servers: {} }).servers).map(([name, v]) => ({ name, command: v.command, args: v.args })) };
}
function remove(kind, name) {
  if (kind === 'skill') { if (!NAME_RE.test(name || '')) throw fail('名字不对'); fs.rmSync(path.join(SKILLS, name), { recursive: true, force: true }); return { ok: true, log: '已移除技能 ' + name }; }
  if (kind === 'mcp') { const m = readJson(MCP_FILE, { servers: {} }); delete m.servers[name]; writeJson(MCP_FILE, m); return { ok: true, log: '已移除 MCP 服务 ' + name }; }
  throw fail('只能移除技能或 MCP');
}

// 电脑被重建之后，把以前批准装过的软件包重新装上（在后台慢慢装）。
(async () => {
  if (fs.existsSync(MARK)) return;
  const done = new Set();
  for (const e of readJson(LIST_FILE, [])) {
    const key = e.method + ':' + (e.packages || []).join(',');
    if (done.has(key) || !PKG_RE[e.method]) continue;
    done.add(key);
    while (busy) await new Promise((r) => setTimeout(r, 2000));
    busy = true;
    try { const r = await installPackages(e.method, e.packages); console.log('[restore]', key, r.ok ? 'ok' : 'failed'); } catch (err) { console.log('[restore]', key, err.message); }
    busy = false;
  }
  fs.writeFileSync(MARK, new Date().toISOString());
})();

http.createServer((req, res) => {
  const send = (status, obj) => { const d = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(d) }); res.end(d); };
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/list') return send(200, listing());
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
  const given = Buffer.from(String(req.headers['x-install-token'] || '')), want = Buffer.from(TOKEN);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(403, { ok: false, log: '没有安装口令：只有经过 CEO Agent 批准的安装才会被执行' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 200000) req.destroy(); });
  req.on('end', async () => {
    let b;
    try { b = JSON.parse(body || '{}'); } catch (e) { return send(400, { ok: false, log: '请求格式不对' }); }
    if (busy) return send(200, { ok: false, log: '安装器正在装别的东西，稍等一会儿再试' });
    busy = true;
    try {
      let r;
      if (url.pathname === '/install') { r = await installPackages(b.method, b.packages); if (r.ok) record({ method: b.method, packages: b.packages, req: String(b.req || '') }); }
      else if (url.pathname === '/skill') r = b.content ? await installSkillText(b.name, b.content) : await installSkillRepo(b.name, b.repo, b.path, b.ref);
      else if (url.pathname === '/mcp') r = await installMcp(b.name, b.command, b.args);
      else if (url.pathname === '/remove') r = remove(b.kind, b.name);
      else return send(404, { ok: false, log: 'not found' });
      send(200, r);
    } catch (e) { send(200, { ok: false, log: e.expected ? e.message : '安装器出错：' + String(e.message || e).slice(0, 300) }); if (!e.expected) console.error(e); }
    finally { busy = false; }
  });
}).listen(PORT, '127.0.0.1', () => console.log('installer on 127.0.0.1:' + PORT));
