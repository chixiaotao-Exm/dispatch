// Bot 的"扩展申请"：Bot 想要一个新工具 / 技能 / MCP 服务时提交申请，
// 调度台的 CEO Agent 审批（只看会不会影响现有系统），批准后由"开发者"给出安装方案，这里负责执行并核验。
//   waiting（等 CEO 审批）→ denied（没批准） / approved（已批准，等开发者）→ installing → installed / failed
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createExt(ctx) {
  const { DATA, TOOLS_URL, fail, clip, getBot } = ctx;
  const FILE = path.join(DATA, 'toolreqs.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } };
  let reqs = read();
  const save = () => { reqs = reqs.slice(-200); fs.writeFileSync(FILE + '.tmp', JSON.stringify(reqs)); fs.renameSync(FILE + '.tmp', FILE); };
  // 服务重启时，没走完的申请直接作废（提交它的那次对话已经断了）。
  for (const r of reqs) if (['waiting', 'approved', 'installing'].includes(r.state)) { r.state = 'failed'; r.result = 'Bot 服务重启，这条申请没有走完'; r.endedAt = Date.now(); }
  save();
  const TOKEN = (() => { try { return fs.readFileSync(path.join(process.env.CREDENTIALS_DIRECTORY || '', 'install-token'), 'utf8').trim(); } catch (e) { return process.env.BOT_INSTALL_TOKEN || ''; } })();
  const KINDS = { tool: '工具', skill: '技能', mcp: 'MCP 服务' };
  const REVIEW_TIMEOUT = 180000, MAX_PLANS = 2;
  const pub = (r) => ({ ...r });
  const find = (id) => { const r = reqs.find((x) => x.id === id); if (!r) throw fail(404, '没有这条申请'); return r; };

  // ---- 已经装了什么（给系统提示用，隔一会儿刷新一次）----
  let installed = { packages: [], skills: [], mcp: [], at: 0 };
  async function refresh(force) {
    if (!force && Date.now() - installed.at < 60000) return installed;
    try { const r = await fetch(TOOLS_URL + '/ext/list', { signal: AbortSignal.timeout(8000) }); const j = await r.json(); installed = { packages: j.packages || [], skills: j.skills || [], mcp: j.mcp || [], at: Date.now() }; }
    catch (e) { installed.at = Date.now() - 50000; }
    return installed;
  }
  refresh(true);
  setInterval(() => refresh(false), 60000).unref();
  function promptSection() {
    const lines = [];
    if (installed.skills.length) lines.push('### 已安装的技能（用到时先 skill_read 读它的说明，再照着做）\n' + installed.skills.map((s) => `- ${s.name}：${s.description || '（没有说明）'}`).join('\n'));
    if (installed.mcp.length) lines.push('### 已登记的 MCP 服务（先 mcp_tools 看它有哪些工具，再 mcp_call 调用）\n' + installed.mcp.map((m) => `- ${m.name}`).join('\n'));
    const pk = [...new Set(installed.packages.flatMap((p) => (p.packages || []).map((x) => `${x}（${p.method}）`)))];
    if (pk.length) lines.push('### 后来加装的软件包\n' + pk.slice(-60).join('、'));
    return lines.length ? '\n## 你的扩展\n' + lines.join('\n\n') + '\n' : '';
  }

  // ---- Bot 提交申请，然后等结果 ----
  async function request(botId, args, signal, run) {
    const bot = getBot(botId);
    const kind = KINDS[args.kind] ? args.kind : 'tool';
    const name = String(args.name || '').trim().slice(0, 80), purpose = String(args.purpose || '').replace(/\s+/g, ' ').trim().slice(0, 600), source = String(args.source || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (name.length < 2) return { ok: false, output: '要写清楚想要的' + KINDS[kind] + '叫什么。' };
    if (purpose.length < 8) return { ok: false, output: '要写清楚拿它做什么（purpose），CEO Agent 和开发者都要看这个。' };
    if (!TOKEN) return { ok: false, output: '这台调度台还没有配置安装口令，暂时不能申请扩展。请告诉用户。' };
    const since = Date.now() - 3600000;
    if (reqs.filter((r) => r.bot === botId && r.createdAt > since).length >= 8) return { ok: false, output: '你这一小时已经申请了 8 次，先停下来，和用户说明你需要什么。' };
    const dup = reqs.find((r) => r.kind === kind && r.name.toLowerCase() === name.toLowerCase() && r.state === 'installed' && r.createdAt > Date.now() - 30 * 86400000);
    const r = { id: crypto.randomBytes(5).toString('hex'), bot: botId, botName: bot.name, kind, name, purpose, source, state: 'waiting', createdAt: Date.now(), review: null, plans: [], result: '', dupOf: dup ? dup.id : undefined };
    reqs.push(r); save();
    const started = Date.now();
    for (;;) {
      if (signal.aborted) { if (['waiting', 'approved'].includes(r.state)) { r.state = 'failed'; r.result = '用户按了停止，申请已撤回'; r.endedAt = Date.now(); save(); } throw new Error('aborted'); }
      if (r.state === 'waiting' && Date.now() - started > REVIEW_TIMEOUT) { r.state = 'denied'; r.review = { verdict: 'deny', reason: 'CEO Agent 三分钟内没有回应，没有批准', at: Date.now() }; r.endedAt = Date.now(); save(); }
      if (r.state === 'approved' && Date.now() - (r.approvedAt || started) > 240000) { r.state = 'failed'; r.result = '开发者四分钟内没有给出安装方案'; r.endedAt = Date.now(); save(); }
      run.status = { waiting: '等 CEO Agent 审批：' + name, approved: 'CEO Agent 已批准 · 等开发者安装：' + name, installing: '开发者正在安装：' + name }[r.state] || run.status;
      if (r.state === 'denied') return { ok: false, output: `CEO Agent 没有批准安装「${name}」：${r.review.reason}。不要换个名字重新申请；改用你已有的工具想办法，或者如实告诉用户这件事做不了、卡在哪里。`, ext: pub(r) };
      if (r.state === 'failed') return { ok: false, output: `「${name}」没有装上：${r.result}`, ext: pub(r) };
      if (r.state === 'installed') { await refresh(true); return { ok: true, output: `「${name}」已经装好。CEO Agent：${r.review.reason}。开发者：${r.result}`, ext: pub(r) }; }
      await new Promise((res) => setTimeout(res, 1500));
    }
  }

  // ---- 调安装器 / 在 Bot 电脑上跑一条核验命令 ----
  async function installer(route, body) {
    try {
      const res = await fetch(TOOLS_URL + '/ext/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Install-Token': TOKEN }, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
      return await res.json();
    } catch (e) { return { ok: false, log: '连不上 Bot 的电脑：' + String(e.message || e).slice(0, 100) }; }
  }
  async function botTool(botId, name, args) {
    try { const res = await fetch(TOOLS_URL + '/tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot: botId, name, args }), signal: AbortSignal.timeout(150000) }); return await res.json(); }
    catch (e) { return { ok: false, output: '连不上 Bot 的电脑' }; }
  }
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  // 开发者交来的安装方案：照着装，再核验。返回 { ok, log, final }；final 表示这条申请已经有了最终结果。
  async function applyPlan(r, plan) {
    if (r.state !== 'approved') throw fail(409, '这条申请现在不能安装（状态：' + r.state + '）');
    if (r.plans.length >= MAX_PLANS) throw fail(409, '这条申请的安装次数用完了');
    const p = { method: String(plan.method || ''), note: String(plan.note || '').slice(0, 300), by: String(plan.by || '开发者').slice(0, 60), at: Date.now() };
    r.state = 'installing'; r.plans.push(p); save();
    let out;
    if (p.method === 'cannot') out = { ok: false, log: '开发者认为装不了：' + (p.note || '没有说明原因'), stop: true };
    else if (r.kind === 'tool' && ['apt', 'pip', 'npm'].includes(p.method)) {
      p.packages = Array.isArray(plan.packages) ? plan.packages.map(String).slice(0, 8) : [];
      p.verify = String(plan.verify || '').slice(0, 300);
      out = await installer('install', { method: p.method, packages: p.packages, req: r.id });
      if (out.ok && p.verify) {   // 装完以 Bot 的身份试跑一下，确认真的能用
        const v = await botTool(r.bot, 'shell', { command: p.verify, timeout: 60 });
        const code = /^退出码 (\d+)/.exec(String(v.output || ''));
        if (!code || code[1] !== '0') out = { ok: false, log: '装上了，但核验命令没通过（' + p.verify + '）：\n' + clip(v.output || '', 800) };
        else out.log = '核验通过：' + p.verify;
      }
    } else if (r.kind === 'skill' && p.method === 'skill_repo') {
      p.name = slug(plan.name || r.name); p.repo = String(plan.repo || ''); p.path = String(plan.path || ''); p.ref = String(plan.ref || '');
      out = await installer('skill', { name: p.name, repo: p.repo, path: p.path, ref: p.ref });
    } else if (r.kind === 'skill' && p.method === 'skill_text') {
      p.name = slug(plan.name || r.name); p.chars = String(plan.content || '').length;
      out = await installer('skill', { name: p.name, content: String(plan.content || '') });
    } else if (r.kind === 'mcp' && p.method === 'mcp') {
      p.name = slug(plan.name || r.name); p.command = String(plan.command || ''); p.args = Array.isArray(plan.args) ? plan.args.map(String).slice(0, 12) : [];
      out = await installer('mcp', { name: p.name, command: p.command, args: p.args });
      if (out.ok) {   // 登记完真的启动一次，看它能不能列出工具
        const v = await botTool(r.bot, 'mcp_tools', { server: p.name });
        if (!v.ok) { out = { ok: false, log: '登记了，但启动不起来：' + clip(v.output || '', 600) }; await installer('remove', { kind: 'mcp', name: p.name }); }
        else out.log = '已登记并能启动。' + clip(String(v.output || '').split('\n')[0], 200);
      }
    } else out = { ok: false, log: `安装方式「${p.method}」和申请的类型（${KINDS[r.kind]}）对不上` };
    p.ok = Boolean(out.ok); p.log = clip(out.log || '', 1500);
    const final = out.ok || out.stop || r.plans.length >= MAX_PLANS;
    if (out.ok) { r.state = 'installed'; r.result = (p.note ? p.note + '。' : '') + describe(p) + '。' + clip(out.log || '', 300); r.installedAs = p.name || (p.packages || []).join(' '); }
    else if (final) { r.state = 'failed'; r.result = clip(out.log || '安装失败', 600); }
    else { r.state = 'approved'; r.approvedAt = Date.now(); }   // 让开发者看着报错再试一次
    if (final) r.endedAt = Date.now();
    save();
    if (out.ok) refresh(true);
    return { ok: Boolean(out.ok), log: p.log, final };
  }
  const describe = (p) => p.method === 'skill_repo' ? `从 ${p.repo}/${p.path} 安装了技能 ${p.name}` : p.method === 'skill_text' ? `写了一个技能 ${p.name}` : p.method === 'mcp' ? `登记了 MCP 服务 ${p.name}（${p.command} ${(p.args || []).join(' ')}）` : `用 ${p.method} 安装了 ${(p.packages || []).join('、')}`;

  // ---- HTTP：给调度台后端（CEO Agent、开发者）和页面用 ----
  async function route(method, name, q, body) {
    if (method === 'GET' && name === '/api/toolreqs') return { requests: reqs.slice(-60).reverse().map(pub), installed: await refresh(false), enabled: Boolean(TOKEN) };
    if (method !== 'POST') return undefined;
    if (name === '/api/toolreq/review') {   // CEO Agent 的结论
      const r = find(body.id);
      if (r.state !== 'waiting') throw fail(409, '这条申请不在等审批');
      const allow = body.verdict === 'allow';
      r.review = { verdict: allow ? 'allow' : 'deny', reason: String(body.reason || '').slice(0, 300) || (allow ? '不影响现有系统' : '没有说明原因'), at: Date.now() };
      r.state = allow ? 'approved' : 'denied'; r.approvedAt = Date.now();
      if (!allow) r.endedAt = Date.now();
      save();
      return { ok: true };
    }
    if (name === '/api/toolreq/plan') return applyPlan(find(body.id), body.plan && typeof body.plan === 'object' ? body.plan : {});
    if (name === '/api/ext/remove') {   // 主人在页面上移除一个技能或 MCP 服务
      const out = await installer('remove', { kind: body.kind, name: body.name });
      await refresh(true);
      if (!out.ok) throw fail(400, out.log || '移除失败');
      return { ok: true };
    }
    return undefined;
  }
  return { request, route, promptSection };
};
