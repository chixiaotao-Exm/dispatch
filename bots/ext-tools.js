// Bot 电脑里"扩展"相关的工具：读已安装的技能、调用已登记的 MCP 服务；以及把安装请求转交给安装器。
// 这里以普通用户 bot 的身份运行，没有安装权限；安装请求只是原样转给安装器，由它核对口令。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const S = '/var/lib/bot-installer';
const SKILLS = path.join(S, 'skills');
const MCP_FILE = path.join(S, 'mcp.json');
const INSTALLER = 'http://127.0.0.1:7697';
const fail = (m) => Object.assign(new Error(m), { expected: true });
const clip = (s, n) => { s = String(s === undefined || s === null ? '' : s); return s.length > n ? s.slice(0, n) + '\n…（后面还有 ' + (s.length - n) + ' 字，已省略）' : s; };
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;

function skillRead(a) {
  if (!NAME_RE.test(a.name || '')) throw fail('技能名不对。已安装的技能见系统提示里的列表');
  const dir = path.join(SKILLS, a.name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw fail('没有安装这个技能：' + a.name);
  const rel = String(a.file || 'SKILL.md');
  const p = path.resolve(dir, rel);
  if (!p.startsWith(dir + path.sep)) throw fail('只能读这个技能文件夹里的文件');
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) throw fail('技能里没有这个文件：' + rel);
  if (st.isDirectory()) return { output: rel + '/ 里有：\n' + fs.readdirSync(p).join('\n') };
  const files = [];
  const walk = (d, pre) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), pre + e.name + '/'); else files.push(pre + e.name); } };
  walk(dir, '');
  return { output: (rel === 'SKILL.md' && files.length > 1 ? '（这个技能的文件夹在 ' + dir + '，里面还有：' + files.filter((f) => f !== 'SKILL.md').slice(0, 40).join('、') + '。脚本可以直接用 shell 运行。）\n\n' : '') + clip(fs.readFileSync(p, 'utf8'), 30000) };
}

// 最小的 MCP 客户端：启动那个服务（标准输入输出方式），握手，然后列出工具或调用一个工具，用完就关掉。
function mcpSession(server, env, cwd, work) {
  let conf;
  try { conf = JSON.parse(fs.readFileSync(MCP_FILE, 'utf8')).servers[server]; } catch (e) { conf = null; }
  if (!conf) throw fail('没有登记这个 MCP 服务：' + server + '。已登记的见系统提示里的列表');
  return new Promise((resolve, reject) => {
    const child = spawn(conf.command, conf.args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', errOut = '', nextId = 1, finished = false;
    const waiting = new Map();
    const finish = (err, val) => { if (finished) return; finished = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ } err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(fail('MCP 服务 ' + server + ' 超过 120 秒没有完成' + (errOut ? '：' + errOut.slice(-300) : ''))), 120000);
    const rpc = (method, params) => new Promise((res, rej) => { const id = nextId++; waiting.set(id, { res, rej }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
        const w = msg.id !== undefined && waiting.get(msg.id);
        if (!w) continue;
        waiting.delete(msg.id);
        if (msg.error) w.rej(fail('MCP 服务返回错误：' + String(msg.error.message || JSON.stringify(msg.error)).slice(0, 300))); else w.res(msg.result);
      }
    });
    child.stderr.on('data', (c) => { if (errOut.length < 4000) errOut += c; });
    child.on('error', (e) => finish(fail('MCP 服务启动不了：' + e.message)));
    child.on('close', (code) => finish(fail('MCP 服务自己退出了（退出码 ' + code + '）' + (errOut ? '：' + errOut.trim().slice(-400) : ''))));
    (async () => {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bot', version: '1.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return work(rpc);
    })().then((v) => finish(null, v), (e) => finish(e));
  });
}
async function mcpTools(a, env, cwd) {
  const r = await mcpSession(String(a.server || ''), env, cwd, (rpc) => rpc('tools/list', {}));
  const tools = (r && r.tools) || [];
  return { output: tools.length ? 'MCP 服务 ' + a.server + ' 提供 ' + tools.length + ' 个工具：\n' + tools.map((t) => '- ' + t.name + '：' + String(t.description || '').replace(/\s+/g, ' ').slice(0, 200) + '\n  参数：' + JSON.stringify((t.inputSchema && t.inputSchema.properties) || {}).slice(0, 400)).join('\n') : '这个 MCP 服务没有提供任何工具。' };
}
async function mcpCall(a, env, cwd) {
  if (typeof a.tool !== 'string' || !a.tool) throw fail('要给出工具名（先用 mcp_tools 看有哪些）');
  const args = a.args && typeof a.args === 'object' ? a.args : {};
  const r = await mcpSession(String(a.server || ''), env, cwd, (rpc) => rpc('tools/call', { name: a.tool, arguments: args }));
  const text = ((r && r.content) || []).map((c) => (c.type === 'text' ? c.text : '[' + c.type + ' 类型的内容，这里不显示]')).join('\n');
  if (r && r.isError) throw fail('工具报错：' + clip(text, 1000));
  return { output: clip(text || '（工具没有返回文字内容）', 20000) };
}

// /ext/list 任何人可读；其余的原样转给安装器（带着大脑给的口令）。
async function handle(req, res, url, readJson, send) {
  if (req.method === 'GET' && url.pathname === '/ext/list') {
    try { const r = await fetch(INSTALLER + '/list', { signal: AbortSignal.timeout(8000) }); return send(res, 200, await r.json()); }
    catch (e) { return send(res, 200, { packages: [], skills: [], mcp: [], error: '安装器没有响应' }); }
  }
  if (req.method === 'POST' && /^\/ext\/(install|skill|mcp|remove)$/.test(url.pathname)) {
    const body = await readJson(req);
    try {
      const r = await fetch(INSTALLER + url.pathname.slice(4), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Install-Token': String(req.headers['x-install-token'] || '') }, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
      return send(res, 200, await r.json());
    } catch (e) { return send(res, 200, { ok: false, log: '连不上安装器：' + String(e.message || e).slice(0, 120) }); }
  }
  return false;
}

module.exports = { skillRead, mcpTools, mcpCall, handle };
