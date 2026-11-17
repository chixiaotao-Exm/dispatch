// 专用 Agent 的扩展安装（技能、MCP 服务）：CEO Agent 批准、开发者给出方案之后，调度台把方案交到这里执行。
// 技能装进技能库，MCP 登记进 MCP 库 —— 和主人在"市场"里手动安装是同一个地方，装完下一个任务起生效。
// 系统软件包不在这里装（这里没有管理员权限），那一类由容器外的审批服务去装。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const ROOT = fs.realpathSync(process.env.FILES_ROOT || '/workspace');
const SKILLS_DIR = path.join(ROOT, 'storage', 'skills');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// 登记 MCP 之后真的启动一次，握手并列出工具，确认它能用。
function probeMcp(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', errOut = '', done = false;
    const finish = (ok, log) => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ } resolve({ ok, log }); };
    const timer = setTimeout(() => finish(false, '启动后 120 秒没有回应' + (errOut ? '：' + errOut.trim().slice(-300) : '')), 120000);
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.id === 1) { if (m.error) return finish(false, '握手失败：' + JSON.stringify(m.error).slice(0, 200)); send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
        if (m.id === 2) { const tools = (m.result && m.result.tools) || []; return finish(!m.error, m.error ? '列不出工具：' + JSON.stringify(m.error).slice(0, 200) : '能启动，提供 ' + tools.length + ' 个工具：' + tools.map((t) => t.name).slice(0, 12).join('、')); }
      }
    });
    child.stderr.on('data', (c) => { if (errOut.length < 3000) errOut += c; });
    child.on('error', (e) => finish(false, '启动不了：' + e.message));
    child.on('close', (code) => finish(false, '它自己退出了（退出码 ' + code + '）' + (errOut ? '：' + errOut.trim().slice(-300) : '')));
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-ext', version: '1.0' } } });
  });
}

module.exports = async function applyExt(market, body) {
  const kind = body.kind, plan = body.plan && typeof body.plan === 'object' ? body.plan : {};
  try {
    if (kind === 'skill' && plan.method === 'skill_repo') {
      const name = slug(plan.name);
      if (!NAME_RE.test(name)) return { ok: false, log: '技能名只能用小写字母、数字、短横线' };
      if (!/^[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,80}$/.test(plan.repo || '')) return { ok: false, log: '仓库要写成 owner/name' };
      const r = await market.installSkill(plan.repo, name, true, String(plan.path || '').replace(/^\/+|\/+$/g, '') || undefined);
      return { ok: true, name, log: `已从 ${plan.repo}/${plan.path || ''} 把技能 ${name} 装进技能库（${r.files} 个文件）` };
    }
    if (kind === 'skill' && plan.method === 'skill_text') {
      const name = slug(plan.name), content = String(plan.content || '');
      if (!NAME_RE.test(name)) return { ok: false, log: '技能名只能用小写字母、数字、短横线' };
      if (content.trim().length < 80 || content.length > 40000) return { ok: false, log: '技能内容太短或太长（80 到 40000 字）' };
      if (!/^---\s*\n[\s\S]*?\bdescription:[\s\S]*?\n---/.test(content)) return { ok: false, log: 'SKILL.md 开头缺少 name / description 那一段，Claude Code 不会加载它' };
      const dir = path.join(SKILLS_DIR, name);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'SKILL.md'), content);
      await fsp.writeFile(path.join(dir, '.market.json'), JSON.stringify({ source: '开发者编写', skillId: name, installedAt: Date.now() }, null, 2));
      return { ok: true, name, log: `已把技能 ${name} 写进技能库（SKILL.md，${content.length} 字）` };
    }
    if (kind === 'mcp' && plan.method === 'mcp') {
      const name = slug(plan.name), command = String(plan.command || ''), args = Array.isArray(plan.args) ? plan.args.map(String) : null;
      if (!NAME_RE.test(name)) return { ok: false, log: 'MCP 名只能用小写字母、数字、短横线' };
      if (command !== 'npx') return { ok: false, log: '这里的 MCP 服务只能用 npx 启动' };
      if (!args || !args.length || args.length > 12 || args.some((a) => a.length > 200 || /[\0\n\r;|&`$<>]/.test(a))) return { ok: false, log: '启动参数不合规' };
      const probe = await probeMcp(command, args);
      if (!probe.ok) return { ok: false, log: '没有登记：试着启动了一次，' + probe.log };
      const { conf, meta } = await market.readMcp();
      conf.mcpServers[name] = { command, args };
      meta[name] = { name: args.find((a) => !a.startsWith('-')) || name, src: '开发者安装', version: '', installedAt: Date.now() };
      await market.writeMcp(conf, meta);
      return { ok: true, name, log: `已登记进 MCP 库：${name}（${command} ${args.join(' ')}）。${probe.log}` };
    }
    return { ok: false, log: `安装方式「${plan.method}」和申请的类型对不上` };
  } catch (e) {
    return { ok: false, log: String(e.message || e).slice(0, 400) };
  }
};
