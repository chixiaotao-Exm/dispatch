// 技能市场和 MCP 市场：从公开目录里搜索，一键装进专用 Agent 的技能库 / MCP 库。
// 数据来源：
//   技能  - Anthropic 官方仓库 github.com/anthropics/skills（精选）、skills.sh 的公开搜索接口（社区，按安装量）
//   MCP   - 官方注册表 registry.modelcontextprotocol.io
// 中文社区（默认）：技能 - SkillsMP（skillsmp.com，支持中文搜索）；MCP - 魔搭 ModelScope 的 MCP 广场（modelscope.cn/mcp）
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT = fs.realpathSync(process.env.FILES_ROOT || '/workspace');
const SKILLS_DIR = path.join(ROOT, 'storage', 'skills');
const MCP_DIR = path.join(ROOT, 'storage', 'mcp');
const MCP_FILE = path.join(MCP_DIR, 'servers.json');
const MCP_META = path.join(MCP_DIR, '.market.json');
const OFFICIAL = 'anthropics/skills';
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const MAX_FILES = 300, MAX_BYTES = 30 * 1024 * 1024;

const fail = (status, message) => Object.assign(new Error(message), { status });
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}
async function get(url, asText) {
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': 'market-browser', Accept: asText ? '*/*' : 'application/json' }, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw fail(502, '连不上 ' + new URL(url).host + '，稍后再试'); }
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) throw fail(502, new URL(url).host + ' 暂时限制了访问频率，过几分钟再试');
    if (res.status === 404) throw fail(404, '在 ' + new URL(url).host + ' 上没有找到');
    throw fail(502, new URL(url).host + ' 返回 ' + res.status);
  }
  return asText ? res.text() : res.json();
}
// SKILL.md 开头的 name / description。
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  const out = {};
  if (!m) return out;
  for (const key of ['name', 'description']) {
    const x = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm').exec(m[1]);
    if (!x) continue;
    let v = x[1].trim();
    if (/^[>|]/.test(v) || !v) { // 多行写法：取后面缩进的那几行
      const rest = m[1].slice(x.index + x[0].length).split(/\r?\n/).slice(1);
      const lines = [];
      for (const l of rest) { if (/^\s+\S/.test(l)) lines.push(l.trim()); else if (l.trim()) break; }
      v = lines.join(' ');
    }
    out[key] = v.replace(/^["']|["']$/g, '');
  }
  return out;
}

// ---------------- 技能 ----------------
const SOURCE_RE = /^[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,80}$/;
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;
function checkSkill(source, skillId) {
  if (!SOURCE_RE.test(source || '') || source.includes('..')) throw fail(400, '来源不对');
  if (!ID_RE.test(skillId || '') || skillId.includes('..')) throw fail(400, '技能名不对');
}
const repoTree = (source) => cached('tree:' + source, 3600e3, async () => {
  const d = await get(`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`);
  return { sha: d.sha, files: (d.tree || []).filter((x) => x.type === 'blob').map((x) => ({ path: x.path, size: x.size || 0, exec: x.mode === '100755' })) };
});
// 在仓库里找到这个技能所在的文件夹。
async function locate(source, skillId, dirPath) {
  checkSkill(source, skillId);
  if (dirPath && (/(^|\/)\.\.(\/|$)/.test(dirPath) || dirPath.length > 300)) throw fail(400, '路径不对');
  const tree = await repoTree(source);
  const dirs = tree.files.filter((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md')).map((f) => f.path.slice(0, -'SKILL.md'.length).replace(/\/$/, ''));
  let dir;
  if (dirPath !== undefined && dirPath !== null) { const want = String(dirPath).replace(/^\/+|\/+$/g, ''); if (dirs.includes(want)) dir = want; } // 市场给了确切位置就用它
  if (dir === undefined) dir = dirs.find((d) => path.posix.basename(d).toLowerCase() === skillId.toLowerCase());
  if (dir === undefined && dirs.length === 1) dir = dirs[0];
  if (dir === undefined) { // 文件夹名对不上时，按 SKILL.md 里写的 name 找
    for (const d of dirs.slice(0, 40)) {
      const fm = frontmatter(await get(`https://raw.githubusercontent.com/${source}/${tree.sha}/${d ? d + '/' : ''}SKILL.md`, true).catch(() => ''));
      if ((fm.name || '').toLowerCase() === skillId.toLowerCase()) { dir = d; break; }
    }
  }
  if (dir === undefined) throw fail(404, '在 ' + source + ' 里没有找到这个技能的文件');
  const prefix = dir ? dir + '/' : '';
  const files = tree.files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, rel: f.path.slice(prefix.length) }));
  return { sha: tree.sha, dir, files, bytes: files.reduce((n, f) => n + f.size, 0) };
}
const skillText = (source, sha, dir) => cached('md:' + source + ':' + sha + ':' + dir, 3600e3, () => get(`https://raw.githubusercontent.com/${source}/${sha}/${dir ? dir + '/' : ''}SKILL.md`, true));

const featured = () => cached('featured', 6 * 3600e3, async () => {
  const tree = await repoTree(OFFICIAL);
  const dirs = tree.files.filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f.path)).map((f) => f.path.split('/')[1]);
  return Promise.all(dirs.map(async (id) => {
    const fm = frontmatter(await skillText(OFFICIAL, tree.sha, 'skills/' + id).catch(() => ''));
    return { source: OFFICIAL, skillId: id, name: fm.name || id, description: fm.description || '', official: true };
  }));
});
const searchSkills = (q) => cached('search:' + q, 600e3, async () => {
  const d = await get('https://skills.sh/api/search?limit=40&q=' + encodeURIComponent(q));
  return (d.skills || []).filter((s) => SOURCE_RE.test(s.source || '') && ID_RE.test(s.skillId || '')).map((s) => ({
    source: s.source, skillId: s.skillId, name: s.name || s.skillId, installs: s.installs || 0, description: '', official: s.source === OFFICIAL,
  }));
});
// 中文社区：SkillsMP。免登录每天只能查 50 次，所以结果缓存久一点；查不了时由调用方退回英文社区。
const zhSkills = (q) => cached('zh:' + q, 6 * 3600e3, async () => {
  const d = await get('https://skillsmp.com/api/v1/skills/search?limit=50&sortBy=stars&q=' + encodeURIComponent(q));
  const out = [];
  for (const s of ((d.data || {}).skills || [])) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/tree\/[^/]+\/?(.*)$/.exec(s.githubUrl || '');
    if (!m || !SOURCE_RE.test(m[1])) continue;
    let dirPath = '';
    try { dirPath = decodeURIComponent(m[2] || '').replace(/\/+$/, ''); } catch (e) { continue; }
    let id = String(s.name || '');
    if (!ID_RE.test(id) || id.includes('..')) id = path.posix.basename(dirPath);
    if (!ID_RE.test(id) || id.includes('..')) continue;
    out.push({ source: m[1], skillId: id, path: dirPath, name: s.name || id, description: s.description || '', stars: s.stars || 0, lang: s.contentLanguage || '', official: m[1] === OFFICIAL });
  }
  return out.filter((x) => x.lang === 'zh').concat(out.filter((x) => x.lang !== 'zh')); // 中文写的排前面
});
async function installedSkills() {
  const out = [];
  let names = [];
  try { names = await fsp.readdir(SKILLS_DIR); } catch (e) { return out; }
  for (const name of names.sort()) {
    const dir = path.join(SKILLS_DIR, name);
    let md;
    try { md = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8'); } catch (e) { continue; }
    let meta = null;
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, '.market.json'), 'utf8')); } catch (e) { /* 不是从市场装的 */ }
    const fm = frontmatter(md);
    out.push({ dir: name, name: fm.name || name, description: fm.description || '', source: meta ? meta.source : null, skillId: meta ? meta.skillId : null, installedAt: meta ? meta.installedAt : null });
  }
  return out;
}
async function skillDetail(source, skillId, dirPath) {
  const loc = await locate(source, skillId, dirPath);
  const md = await skillText(source, loc.sha, loc.dir);
  const fm = frontmatter(md);
  return {
    source, skillId, name: fm.name || skillId, description: fm.description || '', files: loc.files.length, bytes: loc.bytes,
    hasScripts: loc.files.some((f) => /\.(py|sh|js|ts|rb|pl|exe|bin)$/i.test(f.rel) || f.exec),
    url: `https://github.com/${source}/tree/${loc.sha}/${loc.dir}`,
    readme: md.length > 12000 ? md.slice(0, 12000) + '\n…（后面还有，安装后可在技能库里查看全文）' : md,
  };
}
async function installSkill(source, skillId, overwrite, dirPath) {
  const loc = await locate(source, skillId, dirPath);
  if (loc.files.length > MAX_FILES || loc.bytes > MAX_BYTES) throw fail(400, `这个技能太大了（${loc.files.length} 个文件，${Math.round(loc.bytes / 1048576)} MB），没有安装`);
  for (const f of loc.files) if (!f.rel || f.rel.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) throw fail(400, '技能里有不安全的文件路径，没有安装');
  const target = path.join(SKILLS_DIR, skillId);
  const exists = await fsp.stat(target).then(() => true, () => false);
  if (exists && !overwrite) throw fail(409, '技能库里已经有同名的技能');
  await fsp.mkdir(SKILLS_DIR, { recursive: true });
  const tmp = path.join(SKILLS_DIR, '.installing-' + Date.now().toString(36));
  try {
    const queue = loc.files.slice();
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const res = await fetch(`https://raw.githubusercontent.com/${source}/${loc.sha}/${f.path.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw fail(502, '下载 ' + f.rel + ' 失败（' + res.status + '）');
        const buf = Buffer.from(await res.arrayBuffer());
        const dest = path.join(tmp, ...f.rel.split('/'));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, buf, { mode: f.exec ? 0o755 : 0o644 });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    await fsp.writeFile(path.join(tmp, '.market.json'), JSON.stringify({ source, skillId, path: loc.dir, sha: loc.sha, installedAt: Date.now() }, null, 2));
    if (exists) await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(tmp, target);
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e.status ? e : fail(502, '安装失败：' + (e.message || e));
  }
  return { ok: true, dir: skillId, files: loc.files.length };
}
async function uninstallSkill(dir) {
  if (!ID_RE.test(dir || '') || dir.includes('..')) throw fail(400, '技能名不对');
  const target = path.join(SKILLS_DIR, dir);
  if (!(await fsp.stat(path.join(target, 'SKILL.md')).then(() => true, () => false))) throw fail(404, '技能库里没有这个技能');
  await fsp.rm(target, { recursive: true, force: true });
  return { ok: true };
}

// ---------------- MCP ----------------
// 把注册表里的一条记录，整理成"有哪几种装法"。
function mcpOptions(s) {
  const opts = [];
  for (const p of s.packages || []) {
    const kind = p.registryType || p.registry_type || '';
    const transport = (p.transport || {}).type || 'stdio';
    const needArgs = (p.packageArguments || []).filter((a) => a.isRequired && !a.value && !a.default).map((a) => a.name || a.valueHint || '参数');
    const o = { kind, label: (kind === 'npm' ? 'npx ' : kind === 'pypi' ? 'uvx ' : kind + ' ') + p.identifier + (p.version ? '@' + p.version : ''), identifier: p.identifier, version: p.version || '',
      fields: (p.environmentVariables || []).map((e) => ({ name: e.name, description: e.description || '', required: Boolean(e.isRequired), secret: Boolean(e.isSecret), def: e.default || '' })) };
    if (kind !== 'npm') o.blocked = kind === 'pypi' ? '需要 Python 的 uvx，Agent 的环境里没有装' : kind === 'oci' ? '需要 Docker，Agent 的环境里不能用' : '暂不支持这种安装方式（' + kind + '）';
    else if (transport !== 'stdio') o.blocked = '暂不支持这种连接方式（' + transport + '）';
    else if (needArgs.length) o.blocked = '它还需要额外的启动参数（' + needArgs.join('、') + '），请到 MCP 库里手动配置';
    else if (!/^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i.test(p.identifier || '')) o.blocked = '包名不规范，没法自动安装';
    opts.push(o);
  }
  for (const r of s.remotes || []) {
    const o = { kind: 'remote', type: r.type, label: '远程服务 ' + r.url, url: r.url,
      fields: (r.headers || []).map((h) => ({ name: h.name, description: h.description || '', required: Boolean(h.isRequired), secret: Boolean(h.isSecret), def: '', hint: h.value || '' })) };
    if (!['streamable-http', 'sse', 'http'].includes(r.type)) o.blocked = '暂不支持这种连接方式（' + r.type + '）';
    else if (!/^https:\/\//.test(r.url || '') || /[{}]/.test(r.url)) o.blocked = '它的地址需要手动填写参数，请到 MCP 库里手动配置';
    opts.push(o);
  }
  return opts;
}
const mcpView = (x) => {
  const s = x.server || x;
  return { name: s.name, title: s.title || '', description: s.description || '', version: s.version || '', repo: (s.repository || {}).url || '', website: s.websiteUrl || '', options: mcpOptions(s) };
};
const searchMcp = (q, cursor) => cached('mcp:' + q + ':' + cursor, 600e3, async () => {
  const d = await get(REGISTRY + '?version=latest&limit=40' + (q ? '&search=' + encodeURIComponent(q) : '') + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
  return { servers: (d.servers || []).map(mcpView), next: (d.metadata || {}).nextCursor || null };
});
// 中文社区：魔搭 ModelScope 的 MCP 广场。
const MS = 'https://www.modelscope.cn/openapi/v1/mcp/servers';
const MS_ID = /^@?[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}$/;
const msList = (q, page) => cached('ms:' + q + ':' + page, 1800e3, async () => {
  let res;
  try { res = await fetch(MS, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'User-Agent': 'market-browser' }, body: JSON.stringify({ page_number: page, page_size: 40, search: q }), signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw fail(502, '连不上魔搭社区'); }
  if (!res.ok) throw fail(502, '魔搭社区返回 ' + res.status);
  const d = ((await res.json()) || {}).data || {};
  const list = (d.mcp_server_list || []).filter((x) => MS_ID.test(x.id || ''));
  return {
    servers: list.map((x) => ({ src: 'ms', name: x.id, title: x.chinese_name || x.name || x.id, description: x.description || '', version: '', views: Number(x.view_count) || 0, tags: (x.categories || []).slice(0, 3) })),
    next: page * 40 < (d.total_count || 0) ? String(page + 1) : null,
  };
});
function msOptions(x) {
  const opts = [];
  const schema = (x.env_schema && x.env_schema.properties) || {}, required = (x.env_schema && x.env_schema.required) || [];
  for (const group of Array.isArray(x.server_config) ? x.server_config : []) {
    for (const [key, c] of Object.entries((group && group.mcpServers) || {})) {
      if (!c || typeof c !== 'object') continue;
      if (c.url) {
        const type = /sse/i.test(c.type || '') || /\/sse(\?|$)/.test(c.url) ? 'sse' : 'http';
        const o = { kind: 'remote', type, key, label: '远程服务 ' + c.url, url: c.url, fields: [] };
        if (!/^https:\/\//.test(c.url) || /[{}<>]/.test(c.url)) o.blocked = '它的地址需要手动填写参数，请到 MCP 库里手动配置';
        opts.push(o);
        continue;
      }
      const args = Array.isArray(c.args) ? c.args : [];
      const o = { kind: c.command === 'npx' ? 'npm' : String(c.command || '?'), key, label: [c.command].concat(args).join(' ').slice(0, 200), args,
        fields: Object.keys(c.env || {}).map((n) => ({ name: n, description: (schema[n] || {}).description || '', required: required.includes(n) || /^<.*>$|your|YOUR/.test(String(c.env[n])), secret: /key|token|secret|password|pwd/i.test(n), def: '', hint: String(c.env[n] || '') })) };
      if (c.command !== 'npx') o.blocked = c.command === 'uvx' || c.command === 'python' || c.command === 'uv' ? '需要 Python 的 ' + c.command + '，Agent 的环境里没有装' : c.command === 'docker' ? '需要 Docker，Agent 的环境里不能用' : '暂不支持这种启动方式（' + (c.command || '没有写') + '）';
      else if (!args.length || args.length > 30 || !args.every((a) => typeof a === 'string' && a.length <= 300 && !/[\r\n\0]/.test(a))) o.blocked = '启动参数不规范，没法自动安装';
      else if (args.some((a) => /^<.*>$|YOUR_|your-|\/path\/to/i.test(a))) o.blocked = '启动参数里有需要你自己改的内容，请到 MCP 库里手动配置';
      opts.push(o);
    }
  }
  return opts;
}
const msDetail = (id) => cached('msd:' + id, 1800e3, async () => {
  if (!MS_ID.test(id || '')) throw fail(400, '名字不对');
  const d = await get(MS + '/' + id.split('/').map(encodeURIComponent).join('/').replace(/^%40/, '@'));
  const x = d.data || d;
  if (!x || !x.id) throw fail(404, '魔搭社区里没有找到这个工具');
  const readme = String(x.readme || '');
  return { src: 'ms', name: x.id, title: x.chinese_name || x.name || x.id, description: x.description || '', version: '', repo: /^https:\/\//.test(x.source_url || '') ? x.source_url : '',
    website: 'https://www.modelscope.cn/mcp/servers/' + x.id, verified: Boolean(x.is_verified), options: msOptions(x),
    readme: readme.length > 8000 ? readme.slice(0, 8000) + '\n…' : readme };
});
async function readMcp() {
  let conf = { mcpServers: {} }, meta = {};
  try { conf = JSON.parse(await fsp.readFile(MCP_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw fail(500, 'MCP 库的 servers.json 格式有误，请先在文件页里修好'); }
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) throw fail(500, 'MCP 库的 servers.json 格式有误，请先在文件页里修好');
  if (!conf.mcpServers || typeof conf.mcpServers !== 'object') conf.mcpServers = {};
  try { meta = JSON.parse(await fsp.readFile(MCP_META, 'utf8')); } catch (e) { /* 还没有从市场装过 */ }
  return { conf, meta };
}
async function writeMcp(conf, meta) {
  await fsp.mkdir(MCP_DIR, { recursive: true });
  await fsp.writeFile(MCP_FILE + '.tmp', JSON.stringify(conf, null, 2) + '\n');
  await fsp.rename(MCP_FILE + '.tmp', MCP_FILE);
  await fsp.writeFile(MCP_META, JSON.stringify(meta, null, 2) + '\n');
}
async function installedMcp() {
  const { conf, meta } = await readMcp();
  return Object.entries(conf.mcpServers).map(([key, c]) => ({
    key, registryName: (meta[key] || {}).name || null, version: (meta[key] || {}).version || '', installedAt: (meta[key] || {}).installedAt || null,
    how: c && c.url ? '远程服务 ' + c.url : c && c.command ? [c.command].concat(c.args || []).join(' ') : '（配置不完整）',
    settings: Object.keys((c && (c.env || c.headers)) || {}), // 只给名字，不给值
  }));
}
async function installMcp(body) {
  const name = String(body.name || '');
  const fromMs = body.src === 'ms';
  let s, opts;
  if (fromMs) { s = await msDetail(name); opts = s.options; }
  else {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(name)) throw fail(400, '名字不对');
    const d = await get(REGISTRY + '/' + encodeURIComponent(name) + '/versions/latest');
    s = d.server || d; opts = mcpOptions(s);
  }
  const opt = opts[Number(body.option) || 0];
  if (!opt) throw fail(400, '没有这种安装方式');
  if (opt.blocked) throw fail(400, opt.blocked);
  const values = body.values && typeof body.values === 'object' ? body.values : {};
  const filled = {};
  for (const f of opt.fields) {
    const v = String(values[f.name] === undefined || values[f.name] === null ? '' : values[f.name]).trim() || f.def;
    if (!v && f.required) throw fail(400, '还需要填写：' + f.name);
    if (v.length > 4000 || /[\r\n\0]/.test(v)) throw fail(400, f.name + ' 的内容不对');
    if (v) filled[f.name] = v;
  }
  const config = opt.kind === 'remote'
    ? { type: opt.type === 'sse' ? 'sse' : 'http', url: opt.url, ...(Object.keys(filled).length ? { headers: filled } : {}) }
    : { command: 'npx', args: fromMs ? opt.args : ['-y', opt.identifier + (opt.version ? '@' + opt.version : '')], ...(Object.keys(filled).length ? { env: filled } : {}) };
  const { conf, meta } = await readMcp();
  const key = ((fromMs && opt.key ? opt.key : name.split('/').pop()).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'server';
  if (conf.mcpServers[key] && (meta[key] || {}).name !== name && !body.overwrite) throw fail(409, 'MCP 库里已经有一个叫 ' + key + ' 的工具');
  conf.mcpServers[key] = config;
  meta[key] = { name, src: fromMs ? 'ms' : 'registry', version: s.version || '', installedAt: Date.now() };
  await writeMcp(conf, meta);
  return { ok: true, key };
}
async function uninstallMcp(key) {
  const { conf, meta } = await readMcp();
  if (!Object.prototype.hasOwnProperty.call(conf.mcpServers, key)) throw fail(404, 'MCP 库里没有这个工具');
  delete conf.mcpServers[key];
  delete meta[key];
  await writeMcp(conf, meta);
  return { ok: true };
}

module.exports = {
  frontmatter, mcpOptions, installSkill, readMcp, writeMcp,
  async get(route, q) {
    const asked = q.get('src') === 'en' ? 'en' : 'zh'; // 默认中文社区；它查不了或没结果时退回英文社区
    if (route === '/skills') {
      const query = (q.get('q') || '').trim().slice(0, 80);
      const installed = await installedSkills();
      const mode = query.length >= 2 ? 'search' : 'featured';
      let src = asked, note = '', items = [];
      if (asked === 'zh') {
        try {
          items = await zhSkills(mode === 'search' ? query : '中文');
          if (!items.length) throw fail(404, '中文社区里没有搜到');
        } catch (e) { src = 'en'; note = (e.status ? e.message : '中文社区暂时不可用') + '，下面是英文社区的结果'; }
      }
      if (src === 'en') items = mode === 'search' ? await searchSkills(query) : await featured();
      return { query, asked, src, note, mode, items, installed };
    }
    if (route === '/skills/detail') return skillDetail(q.get('source'), q.get('skillId'), q.get('path'));
    if (route === '/mcp') {
      const query = (q.get('q') || '').trim().slice(0, 80);
      const installed = await installedMcp();
      let src = asked, note = '', list = null;
      if (asked === 'zh') {
        try {
          list = await msList(query, Math.max(1, Number(q.get('cursor')) || 1));
          if (!list.servers.length) throw fail(404, '中文社区里没有搜到');
        } catch (e) { src = 'en'; note = (e.status ? e.message : '中文社区暂时不可用') + '，下面是英文社区的结果'; }
      }
      if (src === 'en') list = await searchMcp(query, asked === 'en' ? q.get('cursor') || '' : '');
      return { query, asked, src, note, ...list, installed };
    }
    if (route === '/mcp/detail') return msDetail(q.get('id'));
    throw fail(404, 'not found');
  },
  async post(route, body) {
    if (route === '/skills/install') return installSkill(String(body.source || ''), String(body.skillId || ''), body.overwrite === true, typeof body.path === 'string' ? body.path : undefined);
    if (route === '/skills/uninstall') return uninstallSkill(String(body.dir || ''));
    if (route === '/mcp/install') return installMcp(body);
    if (route === '/mcp/uninstall') return uninstallMcp(String(body.key || ''));
    throw fail(404, 'not found');
  },
};
