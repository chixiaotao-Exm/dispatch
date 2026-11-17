// 专用 Agent 的文件管理服务：在浏览器里查看、上传、下载、整理 Agent 工作目录里的文件。
// 跑在容器里，以 agent 身份运行，只能碰 /workspace。它自己不做登录校验：
// 它只监听容器内部端口，外面只能经"加密隧道 + 调度台登录校验"访问到它。零依赖。
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const market = require('./market.js');
const applyExt = require('./ext-apply.js');   // CEO Agent 批准、开发者给出方案后，把技能 / MCP 装进库里

const ROOT = fs.realpathSync(process.env.FILES_ROOT || '/workspace');
const PORT = Number(process.env.FILES_PORT) || 7683;
const BASE = '/files';
const MAX_UPLOAD = 5 * 1024 * 1024 * 1024; // 单个文件最大 5 GB
const MAX_EDIT = 2 * 1024 * 1024;          // 在线查看/编辑的文本文件最大 2 MB
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

const fail = (status, message) => Object.assign(new Error(message), { status });
const inside = (p) => p === ROOT || p.startsWith(ROOT + path.sep);

// 把用户给的路径解析成工作目录里的绝对路径；任何想跳出工作目录的写法（..、符号链接）都拒绝。
async function resolveSafe(userPath) {
  const rel = path.posix.normalize('/' + String(userPath || '').replace(/\\/g, '/'));
  // 用 resolve 而不是 join：resolve 会去掉末尾的斜杠，这样"/"解析出来才严格等于 ROOT，
  // 后面"不能删除/改名工作目录本身"的判断才不会被绕过。
  const abs = path.resolve(ROOT, '.' + rel);
  if (!inside(abs)) throw fail(400, '路径不合法');
  let probe = abs;
  for (;;) {
    try {
      if (!inside(await fsp.realpath(probe))) throw fail(403, '这个路径指向工作目录之外');
      break;
    } catch (e) {
      if (e.status) throw e;
      if (e.code !== 'ENOENT') throw fail(400, '路径不合法');
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent; // 路径还不存在（比如要新建的文件），就检查它已存在的上级目录
    }
  }
  return { abs, rel: rel === '/' ? '/' : rel.replace(/\/$/, '') };
}
function checkName(name) {
  name = String(name || '');
  if (!name || name === '.' || name === '..' || name.length > 255 || /[\/\\\0]/.test(name)) throw fail(400, '名字不合法');
  return name;
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const attachment = (name) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

// ======================= 任务：在后台让 Claude Code 干活 =======================
// 调度台里发来一句话 → 排队 → 用 `claude -p` 在工作目录里无人值守地执行 → 把它的每一步记下来给页面看。
// 一次只跑一个任务，其余排队。任务记录存在 Agent 的主目录里，容器重启也不丢。
// 后台任务没有人在旁边点"允许"，所以用跳过权限确认的模式运行：能这么做是因为它被关在容器里，
// 而且容器里没有任何能登录你服务器的密钥。
const TASK_BASE = '/tasks';
const AGENT_HOME = process.env.AGENT_HOME || '/home/agent';
const TASK_DIR = path.join(AGENT_HOME, '.dispatch-tasks');
const TASK_FILE = path.join(TASK_DIR, 'tasks.json');
const MAX_TASKS = 60, MAX_STEPS = 400, MAX_QUEUED = 10;
const TASK_TIMEOUT_MS = 60 * 60 * 1000;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
// 页面文件每次请求时现读：以后只改页面的话，替换文件即可，不用重启这个服务（重启会打断正在跑的任务）。
const readTaskPage = () => { try { return fs.readFileSync(path.join(__dirname, 'tasks-page.html'), 'utf8'); } catch (e) { return '<p>tasks-page.html missing</p>'; } };

let tasks = [];
try { tasks = JSON.parse(fs.readFileSync(TASK_FILE, 'utf8')); } catch (e) { /* 还没有任务记录 */ }
for (const t of tasks) {
  if (t.status === 'running') { t.status = 'failed'; t.error = '任务服务重启了，这个任务被中断。可以用"接着继续"让它从断点往下做。'; t.endedAt = t.endedAt || Date.now(); }
}
let saveTimer = null;
function saveTasks() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(TASK_DIR, { recursive: true });
      fs.writeFileSync(TASK_FILE + '.tmp', JSON.stringify(tasks));
      fs.renameSync(TASK_FILE + '.tmp', TASK_FILE);
    } catch (e) { console.error('save tasks failed', e.message); }
  }, 300);
}
const clip = (s, n) => { s = String(s === null || s === undefined ? '' : s); return s.length > n ? s.slice(0, n) + '…（内容过长，已截断）' : s; };
// 每种内容的长度上限。Agent 说的话基本不截断；命令输出留得多一些（页面上是可滚动的小框）。
const STEP_LIMIT = { say: 200000, tool: 4000, out: 30000, err: 30000, log: 30000 };
function addStep(task, kind, text) {
  task.steps.push({ t: Date.now(), kind, text: clip(text, STEP_LIMIT[kind] || 4000) });
  if (task.steps.length > MAX_STEPS) task.steps.splice(0, task.steps.length - MAX_STEPS);
  saveTasks();
}
// 把 Agent 调用的工具翻译成一句人能看懂的话。
function describeTool(name, input) {
  const i = input || {};
  const short = (p) => String(p || '').replace(ROOT + '/', '');
  switch (name) {
    case 'Bash': return '运行命令  ' + clip(i.command, 500);
    case 'Read': return '读文件  ' + short(i.file_path);
    case 'Write': return '写文件  ' + short(i.file_path);
    case 'Edit': case 'MultiEdit': return '改文件  ' + short(i.file_path);
    case 'NotebookEdit': return '改笔记本  ' + short(i.notebook_path);
    case 'Glob': return '找文件  ' + clip(i.pattern, 200);
    case 'Grep': return '搜内容  ' + clip(i.pattern, 200);
    case 'WebFetch': return '打开网页  ' + clip(i.url, 300);
    case 'WebSearch': return '搜索  ' + clip(i.query, 200);
    case 'ToolSearch': return '准备工具  ' + clip(String(i.query || '').replace(/^select:/, ''), 200);
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return '更新计划';
    case 'Task': case 'Agent': return '派出子任务  ' + clip(i.description || '', 200);
    default: return name + '  ' + clip(JSON.stringify(i), 300);
  }
}
function onEvent(task, line) {
  line = line.trim();
  if (!line) return;
  let j;
  try { j = JSON.parse(line); } catch (e) { return addStep(task, 'log', line); }
  if (j.type === 'system' && j.subtype === 'init') { task.sessionId = j.session_id; task.model = j.model; return saveTasks(); }
  const content = (j.message && Array.isArray(j.message.content)) ? j.message.content : [];
  if (j.type === 'assistant') {
    for (const c of content) {
      if (c.type === 'text' && c.text && c.text.trim()) addStep(task, 'say', c.text);
      else if (c.type === 'tool_use') addStep(task, 'tool', describeTool(c.name, c.input));
    }
    return;
  }
  if (j.type === 'user') {
    for (const c of content) {
      if (c.type !== 'tool_result') continue;
      const txt = typeof c.content === 'string' ? c.content
        : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : '';
      if (txt.trim()) addStep(task, c.is_error ? 'err' : 'out', txt);
    }
    return;
  }
  if (j.type === 'result') {
    task.gotResult = true;
    task.isError = Boolean(j.is_error);
    task.result = clip(j.result || '', 300000);
    task.turns = j.num_turns;
    if (j.is_error) task.error = clip(j.result || j.subtype || '任务没有成功', 1000);
    saveTasks();
  }
}
let current = null; // { task, child }
function killTree(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* 已经退出 */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* 已经退出 */ } }, 5000);
}
function pump() {
  if (current) return;
  const task = tasks.filter((t) => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!task) return;
  task.status = 'running';
  task.startedAt = Date.now();
  saveTasks();
  const args = ['-p', task.prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (task.resumeSession) args.push('--resume', task.resumeSession);
  let child;
  try {
    child = spawn(CLAUDE_BIN, args, {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: AGENT_HOME, USER: 'agent', LOGNAME: 'agent', OPS_AGENT: task.source ? 'auto' : 'agent' }, // 定时/告警触发的任务算"自动化 Agent"
    });
  } catch (e) { child = null; }
  let buf = '', errTail = '', finished = false;
  const finish = (code, startError) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (current && current.task === task) current = null;
    task.endedAt = Date.now();
    if (task.stopReason) { task.status = 'stopped'; task.error = task.stopReason; }
    else if (task.gotResult && !task.isError) task.status = 'done';
    else {
      task.status = 'failed';
      task.error = task.error || startError || clip(errTail.trim() || '进程异常退出（退出码 ' + code + '）', 1000);
    }
    saveTasks();
    pump();
  };
  const timer = setTimeout(() => { task.stopReason = '运行超过 60 分钟，已自动停止'; if (child) killTree(child); }, TASK_TIMEOUT_MS);
  if (!child) return finish(null, '无法启动 Claude Code');
  current = { task, child };
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onEvent(task, line); }
  });
  child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
  child.on('error', (e) => finish(null, '无法启动 Claude Code：' + e.message));
  child.on('close', (code) => { if (buf.trim()) onEvent(task, buf); finish(code); });
}
const taskSummary = (t) => ({
  id: t.id, prompt: clip(t.prompt, 200), status: t.status, createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
  steps: t.steps.length, continuedFrom: t.continuedFrom || null, source: t.source || null,
});
// 把一个任务放进队列。手动发的、定时任务、自动化规则触发的，都走这里。
// source：null 表示手动；否则 { type: 'schedule' | 'rule', id, name }。
function enqueueTask(promptText, source, continueFrom) {
  const prompt = String(promptText || '').trim();
  if (!prompt) throw fail(400, '任务内容是空的');
  if (prompt.length > 8000) throw fail(400, '任务内容太长（最多 8000 字）');
  if (tasks.filter((t) => t.status === 'queued').length >= MAX_QUEUED) throw fail(429, '排队的任务太多了，等前面的做完再发');
  const task = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    prompt, status: 'queued', createdAt: Date.now(), startedAt: null, endedAt: null, steps: [], result: '', error: '',
  };
  if (source) task.source = source;
  if (continueFrom) {
    const prev = tasks.find((x) => x.id === continueFrom);
    if (!prev || !prev.sessionId) throw fail(400, '找不到可以接着继续的那个任务');
    task.resumeSession = prev.sessionId;
    task.continuedFrom = prev.id;
  }
  tasks.push(task);
  // 只保留最近的若干条已结束任务。
  const ended = tasks.filter((t) => t.status !== 'queued' && t.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
  while (tasks.length > MAX_TASKS && ended.length) tasks.splice(tasks.indexOf(ended.shift()), 1);
  saveTasks();
  pump();
  return task;
}
const readPage = (name) => { try { return fs.readFileSync(path.join(__dirname, name), 'utf8'); } catch (e) { return '<p>' + name + ' missing</p>'; } };

// ======================= 定时任务 Agent 和 自动化 Agent =======================
// 两者都不自己干活，只负责"在合适的时候替主人发一个任务"给专用 Agent：
//   定时任务 Agent：到点了就发（每天几点 / 每周几几点 / 每隔多久）。
//   自动化 Agent：调度台出现新告警、并且符合某条规则时就发。
// 发出去的任务和手动发的完全一样：同样排队、同样在容器里跑、要动服务器同样得主人批准。
const AUTO_FILE = path.join(TASK_DIR, 'automation.json');
const MIN_INTERVAL_MIN = 5;
const MAX_AUTO_PER_EVENT = 3;
let auto = null;
try { auto = JSON.parse(fs.readFileSync(AUTO_FILE, 'utf8')); } catch (e) { /* 第一次运行 */ }
if (!auto) {
  // 各放一个示例，默认不启用：启用与否、用不用、怎么改都由主人决定。
  auto = {
    schedules: [{
      id: 'example-daily', name: '每日巡检日报', enabled: false, kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5], everyMinutes: 60,
      prompt: '检查三台服务器的磁盘、内存、负载，以及最近 24 小时有没有异常的系统日志。写一份简短的日报，保存为 /workspace/reports/ 下以当天日期命名的 md 文件，并把要点告诉我。',
      lastRunAt: null, nextRunAt: null, lastTaskId: null,
    }],
    rules: [{
      id: 'example-alert', name: '新告警自动排查', enabled: false, keywords: '', level: 'any', cooldownMinutes: 60, fireCount: 0, lastFiredAt: null,
      prompt: '调度台刚出现一条新告警：{alert}\n\n请先用只读命令排查原因，告诉我发生了什么、可能的原因和建议的处理办法。不要自行修改或重启任何东西。',
    }],
    log: [], active: [], fired: {},
  };
}
auto.log = auto.log || []; auto.active = auto.active || []; auto.fired = auto.fired || {};
let autoTimer = null;
function saveAuto() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    try {
      fs.mkdirSync(TASK_DIR, { recursive: true });
      fs.writeFileSync(AUTO_FILE + '.tmp', JSON.stringify(auto));
      fs.renameSync(AUTO_FILE + '.tmp', AUTO_FILE);
    } catch (e) { console.error('save automation failed', e.message); }
  }, 300);
}
function autoLog(kind, name, text, taskId) {
  auto.log.unshift({ t: Date.now(), kind, name, text: clip(text, 300), taskId: taskId || null });
  auto.log.length = Math.min(auto.log.length, 60);
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// 下一次该运行的时刻。时间按容器的时区算（已设成主人电脑所在的时区）。
function nextRun(s, from) {
  if (s.kind === 'interval') return from + s.everyMinutes * 60000;
  const [h, m] = s.time.split(':').map(Number);
  for (let d = 0; d <= 8; d++) {
    const t = new Date(from);
    t.setDate(t.getDate() + d);
    t.setHours(h, m, 0, 0);
    if (t.getTime() <= from) continue;
    if (s.kind === 'weekly' && !s.weekdays.includes(t.getDay())) continue;
    return t.getTime();
  }
  return from + 86400000;
}
function schedulerTick() {
  const now = Date.now();
  let changed = false;
  for (const s of auto.schedules) {
    if (!s.enabled) continue;
    if (!s.nextRunAt) { s.nextRunAt = nextRun(s, now); changed = true; continue; }
    if (now < s.nextRunAt) continue;
    changed = true;
    s.nextRunAt = nextRun(s, now);
    const still = tasks.find((t) => t.source && t.source.id === s.id && (t.status === 'queued' || t.status === 'running'));
    if (still) { autoLog('schedule', s.name, '上一次还没跑完，这一次跳过'); continue; }
    try {
      const task = enqueueTask(s.prompt, { type: 'schedule', id: s.id, name: s.name });
      s.lastRunAt = now; s.lastTaskId = task.id;
      autoLog('schedule', s.name, '到点了，已发出任务', task.id);
    } catch (e) { autoLog('schedule', s.name, '没能发出任务：' + e.message); }
  }
  if (changed) saveAuto();
}
setInterval(schedulerTick, 20000);

// 调度台每轮巡视后把当前的告警列表发过来。只有"新出现"的告警才会触发规则；
// 同一条告警在一条规则的冷却时间内不会重复触发。告警里的数字会被忽略再比较，
// 免得"磁盘已用 86%"变成"87%"就被当成一条新告警。
const alertKey = (text) => String(text).replace(/\d+(\.\d+)?/g, '#').slice(0, 200);
function handleAlerts(alerts) {
  const now = Date.now();
  const list = (Array.isArray(alerts) ? alerts : []).slice(0, 50).map((a) => ({ level: a.level === 'danger' ? 'danger' : 'warning', text: clip(a.text, 500) })).filter((a) => a.text);
  const keys = list.map((a) => alertKey(a.text));
  const fresh = list.filter((a, i) => !auto.active.includes(keys[i]));
  auto.active = keys;
  let sent = 0;
  for (const a of fresh) {
    for (const r of auto.rules) {
      if (!r.enabled || sent >= MAX_AUTO_PER_EVENT) continue;
      if (r.level === 'danger' && a.level !== 'danger') continue;
      const words = String(r.keywords || '').split(/[,，\s]+/).filter(Boolean);
      if (words.length && !words.some((w) => a.text.includes(w))) continue;
      const fk = r.id + '|' + alertKey(a.text);
      if (auto.fired[fk] && now - auto.fired[fk] < (r.cooldownMinutes || 60) * 60000) continue;
      try {
        const prompt = r.prompt.includes('{alert}') ? r.prompt.split('{alert}').join(a.text) : r.prompt + '\n\n告警内容：' + a.text;
        const task = enqueueTask(prompt, { type: 'rule', id: r.id, name: r.name });
        auto.fired[fk] = now; r.lastFiredAt = now; r.fireCount = (r.fireCount || 0) + 1; sent++;
        autoLog('rule', r.name, '告警触发：' + a.text, task.id);
      } catch (e) { autoLog('rule', r.name, '没能发出任务：' + e.message); }
    }
  }
  for (const k of Object.keys(auto.fired)) if (now - auto.fired[k] > 7 * 86400000) delete auto.fired[k];
  saveAuto();
  return { fresh: fresh.length, sent };
}
function lastStatus(sourceId) {
  const t = tasks.filter((x) => x.source && x.source.id === sourceId).sort((a, b) => b.createdAt - a.createdAt)[0];
  return t ? { id: t.id, status: t.status, at: t.createdAt } : null;
}
function autoSummary() {
  return {
    now: Date.now(),
    schedules: auto.schedules.map((s) => ({ ...s, last: lastStatus(s.id) })),
    rules: auto.rules.map((r) => ({ ...r, last: lastStatus(r.id) })),
    log: auto.log.slice(0, 30),
    activeAlerts: auto.active.length,
  };
}
function cleanSchedule(b) {
  const kind = ['daily', 'weekly', 'interval'].includes(b.kind) ? b.kind : null;
  const name = String(b.name || '').trim().slice(0, 60);
  const prompt = String(b.prompt || '').trim();
  if (!name) throw fail(400, '给这个定时任务起个名字');
  if (!prompt) throw fail(400, '写下到点时要 Agent 做什么');
  if (prompt.length > 8000) throw fail(400, '任务内容太长（最多 8000 字）');
  if (!kind) throw fail(400, '请选择执行频率');
  const s = { name, prompt, kind, enabled: Boolean(b.enabled), time: '09:00', weekdays: [1, 2, 3, 4, 5], everyMinutes: 60 };
  if (kind === 'interval') {
    s.everyMinutes = Math.round(Number(b.everyMinutes));
    if (!(s.everyMinutes >= MIN_INTERVAL_MIN && s.everyMinutes <= 7 * 1440)) throw fail(400, '间隔要在 ' + MIN_INTERVAL_MIN + ' 分钟到 7 天之间');
  } else {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time || ''))) throw fail(400, '时间格式不对，应该像 09:00');
    s.time = b.time;
    if (kind === 'weekly') {
      s.weekdays = [...new Set((Array.isArray(b.weekdays) ? b.weekdays : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
      if (!s.weekdays.length) throw fail(400, '至少选一天');
    }
  }
  return s;
}
function cleanRule(b) {
  const name = String(b.name || '').trim().slice(0, 60);
  const prompt = String(b.prompt || '').trim();
  if (!name) throw fail(400, '给这条规则起个名字');
  if (!prompt) throw fail(400, '写下触发时要 Agent 做什么');
  if (prompt.length > 8000) throw fail(400, '任务内容太长（最多 8000 字）');
  const cooldownMinutes = Math.round(Number(b.cooldownMinutes));
  if (!(cooldownMinutes >= 5 && cooldownMinutes <= 7 * 1440)) throw fail(400, '冷却时间要在 5 分钟到 7 天之间');
  return { name, prompt, enabled: Boolean(b.enabled), keywords: String(b.keywords || '').trim().slice(0, 200), level: b.level === 'danger' ? 'danger' : 'any', cooldownMinutes };
}
// ======================= 存储：专用 Agent 的四个库 =======================
// 都是工作目录下的普通文件夹，所以在"文件"页里就能直接增删改：
//   专用知识库 storage/knowledge   放资料文档；Agent 回答相关问题前先来这里查。
//   技能库     storage/skills      Claude Code 的技能，每个技能一个文件夹，里面有 SKILL.md。
//                                  /workspace/.claude/skills 指向这里，所以放进来就会被 Claude Code 加载。
//   MCP 库     storage/mcp         servers.json 里登记外部工具（MCP 服务）。工作目录下的 .mcp.json 指向它。
//   组件库     storage/components  可复用的代码、模板、脚本；Agent 动手前先来找，有复用价值的也存回这里。
const STORE_ROOT = path.join(ROOT, 'storage');
const STORES = [
  { key: 'knowledge', name: '专用知识库', dir: 'knowledge', unit: '个文件', desc: '资料和文档，Agent 回答前先来这里查' },
  { key: 'skills', name: 'Skills 技能库', dir: 'skills', unit: '个技能', desc: '教 Agent 做特定事情的技能包' },
  { key: 'mcp', name: 'MCP 库', dir: 'mcp', unit: '个服务', desc: '让 Agent 能调用的外部工具' },
  { key: 'components', name: '组件库', dir: 'components', unit: '个文件', desc: '可复用的代码、模板和脚本' },
];
const STORE_README = {
  knowledge: '# 专用知识库\n\n把想让 Agent 参考的资料放在这个文件夹里：文档、笔记、表格、规范都可以，可以建子文件夹分类。\nAgent 在回答相关问题或动手之前，会先来这里查。\n',
  skills: '# Skills 技能库\n\n每个技能是一个子文件夹，里面必须有一个 SKILL.md，开头写明技能的名字和什么时候该用它，例如：\n\n```\n---\nname: weekly-report\ndescription: 写周报时使用。说明周报的固定结构和措辞要求。\n---\n\n（这里写具体做法）\n```\n\n放进来的技能会被 Claude Code 自动加载。也可以直接让 Agent 帮你写一个技能存到这里。\n',
  mcp: '# MCP 库\n\nservers.json 里登记 Agent 可以调用的外部工具（MCP 服务），格式是：\n\n```\n{\n  "mcpServers": {\n    "名字": { "command": "npx", "args": ["-y", "某个-mcp-包"] }\n  }\n}\n```\n\n改完后新开的任务和会话就会生效。也可以让 Agent 帮你添加。\n另外，你 Claude 账号里已经连接的那些连接器（比如 Google 日历、文档）不在这个文件里，它们跟着账号走。\n',
  components: '# 组件库\n\n放可以反复使用的东西：代码片段、项目模板、常用脚本、提示词模板。\nAgent 写新东西前会先来这里找有没有现成的；它做出有复用价值的东西时，也会存回这里。\n',
};
function ensureStorage() {
  // 每一步单独做：其中一步失败（比如某个系统不让建链接）不影响其余几步。
  const step = (what, fn) => { try { fn(); } catch (e) { console.error('storage setup: ' + what + ' failed: ' + e.message); } };
  const claudeDir = path.join(AGENT_HOME, '.claude');
  const mcpFile = path.join(STORE_ROOT, 'mcp', 'servers.json');
  step('folders', () => {
    for (const s of STORES) {
      const dir = path.join(STORE_ROOT, s.dir);
      fs.mkdirSync(dir, { recursive: true });
      const readme = path.join(dir, 'README.md');
      if (!fs.existsSync(readme)) fs.writeFileSync(readme, STORE_README[s.key]);
    }
    if (!fs.existsSync(mcpFile)) fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
    fs.mkdirSync(claudeDir, { recursive: true });
  });
  // 让 Claude Code 用上技能库：把它接到工作目录的"项目级技能"位置（/workspace/.claude/skills）。
  // 不去动主目录里的 ~/.claude/skills：那里有 Claude Code 自己维护的内容（比如从账号同步下来的技能）。
  step('skills link', () => {
    const projectClaude = path.join(ROOT, '.claude');
    fs.mkdirSync(projectClaude, { recursive: true });
    const skillsLink = path.join(projectClaude, 'skills');
    try { fs.lstatSync(skillsLink); } catch (e) { fs.symlinkSync(path.join(STORE_ROOT, 'skills'), skillsLink); }
  });
  // 让 Claude Code 用上 MCP 库：工作目录下的 .mcp.json 指向库里的 servers.json。
  step('mcp link', () => {
    const projectMcp = path.join(ROOT, '.mcp.json');
    try { fs.lstatSync(projectMcp); } catch (e) { fs.symlinkSync(mcpFile, projectMcp); }
  });
  // 库里登记的 MCP 服务默认启用（否则后台任务里没人点"允许"，永远用不上）。
  step('settings', () => {
    const settingsFile = path.join(claudeDir, 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { /* 没有或损坏就新建 */ }
    if (settings.enableAllProjectMcpServers !== true) {
      settings.enableAllProjectMcpServers = true;
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    }
  });
  // 告诉 Agent 这四个库的存在和用法。
  step('instructions', () => {
    const memo = path.join(claudeDir, 'CLAUDE.md');
    let text = '';
    try { text = fs.readFileSync(memo, 'utf8'); } catch (e) { /* 还没有 */ }
    if (!text.includes('dispatch-agent-storage:start')) {
      fs.writeFileSync(memo, text + (text && !text.endsWith('\n') ? '\n' : '') + [
        '<!-- dispatch-agent-storage:start -->',
        '## 主人给你准备的四个库（都在 /workspace/storage/ 下）',
        '',
        '- `knowledge/` 专用知识库：主人放的资料和文档。回答和它可能相关的问题、或者动手做事之前，先在这里搜一下，以这里的内容为准。',
        '- `skills/` 技能库：你的技能包（每个子文件夹一个 SKILL.md）。主人让你"学会"某件事时，把做法写成技能存到这里。',
        '- `mcp/servers.json` MCP 库：登记你可以调用的外部工具。主人让你接入新工具时，改这个文件。',
        '- `components/` 组件库：可复用的代码、模板、脚本。写新东西前先来找有没有现成的；做出有复用价值的东西，整理好存回这里并在该目录的 README.md 里记一笔。',
        '  每个组件单独一个文件夹，里面必须放一个 `组件.json`（主人看不懂英文，靠它在调度台的"组件库"页面里认东西），全部用中文写：',
        '  `{"name":"中文名字","kind":"脚本/模板/代码片段/提示词…","summary":"一两句话说它是干什么的","usage":"怎么用、需要准备什么","ask":"主人想用它时可以对你说的一句话","preview":"预览图或网页模板的文件名（没有就不写）"}`',
        '  能出图的组件，顺手放一张效果图叫 `预览.png`。',
        '<!-- dispatch-agent-storage:end -->', '',
      ].join('\n'));
    }
  });
}
ensureStorage();
// ---- 组件库的可视化 ----
// 每个组件是 components 下的一个文件夹（或一个单独的文件）。文件夹里可以放一个"组件.json"，
// 用中文写明它叫什么、是干什么的、怎么用；没有的话就从说明文档里尽量找一句介绍。
const COMP_DIR = path.join(STORE_ROOT, 'components');
const COMP_META = '组件.json';
const COMP_IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const COMP_LABEL = {
  '.py': 'Python 脚本', '.js': 'JavaScript 脚本', '.mjs': 'JavaScript 脚本', '.ts': 'TypeScript 脚本', '.sh': '命令脚本', '.html': '网页模板', '.htm': '网页模板',
  '.css': '样式表', '.json': '数据 / 配置', '.md': '说明文档', '.txt': '文本', '.csv': '表格数据', '.xlsx': 'Excel 表格', '.docx': 'Word 文档', '.pdf': 'PDF 文档',
  '.png': '图片', '.jpg': '图片', '.jpeg': '图片', '.webp': '图片', '.gif': '图片', '.svg': '矢量图', '.sql': '数据库脚本', '.yml': '配置', '.yaml': '配置', '.otf': '字体', '.ttf': '字体',
};
const compPlain = (v) => typeof v === 'string' && v && !v.startsWith('.') && !/[\\/\0]/.test(v) && v.length < 200;
function compFileLabel(name) {
  if (name === COMP_META) return '中文说明卡';
  if (/^(readme|使用说明|说明)/i.test(name)) return '说明文档';
  if (/^(example|sample|示例)/i.test(name)) return '示例数据';
  return COMP_LABEL[path.extname(name).toLowerCase()] || '文件';
}
function compFirstLine(text) { // 说明文档里第一句不是标题的话
  for (const raw of String(text).split('\n')) {
    const l = raw.trim();
    if (l && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('---')) return l.replace(/[*`]/g, '').slice(0, 200);
  }
  return '';
}
function componentList() {
  let readme = '';
  try { readme = fs.readFileSync(path.join(COMP_DIR, 'README.md'), 'utf8'); } catch (e) { /* 没有也行 */ }
  let entries = [];
  try { entries = fs.readdirSync(COMP_DIR, { withFileTypes: true }); } catch (e) { return { components: [] }; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'README.md' || e.name === 'node_modules') continue;
    const p = path.join(COMP_DIR, e.name);
    const c = { id: e.name, folder: e.isDirectory(), name: '', summary: '', kind: '', usage: '', ask: '', preview: null, files: [], updatedAt: 0, hasCard: false };
    if (e.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(p, { withFileTypes: true }); } catch (err) { continue; }
      for (const f of names) {
        if (f.name.startsWith('.')) continue;
        let st = null;
        try { st = fs.statSync(path.join(p, f.name)); } catch (err) { continue; }
        c.updatedAt = Math.max(c.updatedAt, st.mtimeMs);
        if (c.files.length < 40) c.files.push({ name: f.name, label: f.isDirectory() ? '文件夹' : compFileLabel(f.name), size: f.isDirectory() ? null : st.size });
      }
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(p, COMP_META), 'utf8')); } catch (err) { /* 没写说明卡 */ }
      if (meta && typeof meta === 'object') {
        c.hasCard = true;
        for (const k of ['name', 'summary', 'kind', 'usage', 'ask']) if (typeof meta[k] === 'string') c[k] = meta[k].slice(0, k === 'usage' ? 600 : 300);
        if (compPlain(meta.preview) && c.files.some((f) => f.name === meta.preview)) c.preview = meta.preview;
      }
      const has = (re) => (c.files.find((f) => f.size !== null && re.test(f.name)) || {}).name;
      if (!c.preview) c.preview = has(/^(预览|preview)\.(png|jpe?g|webp|gif)$/i) || has(/\.(png|jpe?g|webp|gif)$/i) || has(/\.html?$/i) || null;
      if (!c.summary) {
        const sec = readme.split(/^## /m).find((x) => x.startsWith(e.name));
        if (sec) c.summary = compFirstLine(sec.split('\n').slice(1).join('\n'));
        const doc = has(/^(使用说明|说明|readme)\.md$/i);
        if (!c.summary && doc) { try { c.summary = compFirstLine(fs.readFileSync(path.join(p, doc), 'utf8')); } catch (err) { /* 读不了就算了 */ } }
      }
    } else {
      let st = null;
      try { st = fs.statSync(p); } catch (err) { continue; }
      c.updatedAt = st.mtimeMs;
      c.files.push({ name: e.name, label: compFileLabel(e.name), size: st.size });
      c.kind = compFileLabel(e.name);
    }
    const pv = c.preview ? path.extname(c.preview).toLowerCase() : '';
    c.previewType = COMP_IMG[pv] ? 'image' : pv ? 'page' : null;
    c.path = '/storage/components' + (c.folder ? '/' + e.name : '');
    out.push(c);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return { components: out, cardFile: COMP_META };
}
// 只给预览用：图片原样返回；网页模板关在沙箱里显示（不能跑脚本、不能联网取东西）。
function componentFile(res, id, f) {
  if (!compPlain(id) || !compPlain(f)) throw fail(400, '参数不对');
  const ext = path.extname(f).toLowerCase();
  const isPage = ext === '.html' || ext === '.htm';
  if (!COMP_IMG[ext] && !isPage) throw fail(400, '这种文件不能预览');
  const p = path.join(COMP_DIR, id, f);
  let st = null;
  try { st = fs.statSync(p); } catch (e) { throw fail(404, '文件不存在'); }
  if (!st.isFile() || st.size > 8 * 1024 * 1024 || !fs.realpathSync(p).startsWith(fs.realpathSync(COMP_DIR) + path.sep)) throw fail(400, '这个文件不能预览');
  res.writeHead(200, {
    'Content-Type': isPage ? 'text/html; charset=utf-8' : COMP_IMG[ext], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  });
  res.end(fs.readFileSync(p));
}
function countFiles(dir, limit) {
  let n = 0, latest = 0;
  const walk = (d, depth) => {
    if (n >= limit || depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'README.md' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) { n++; try { latest = Math.max(latest, fs.statSync(p).mtimeMs); } catch (err) { /* 忽略 */ } }
    }
  };
  walk(dir, 0);
  return { n, latest };
}
function storageSummary() {
  return {
    stores: STORES.map((s) => {
      const dir = path.join(STORE_ROOT, s.dir);
      let count = 0, updatedAt = null, note = '';
      try {
        if (s.key === 'skills') {
          const names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))).map((e) => e.name);
          count = names.length; note = names.slice(0, 4).join('、');
        } else if (s.key === 'mcp') {
          const names = Object.keys((JSON.parse(fs.readFileSync(path.join(dir, 'servers.json'), 'utf8')).mcpServers) || {});
          count = names.length; note = names.slice(0, 4).join('、');
        } else {
          const c = countFiles(dir, 5000);
          count = c.n; updatedAt = c.latest || null;
        }
      } catch (e) { note = s.key === 'mcp' ? 'servers.json 格式有误' : '读取失败'; }
      return { key: s.key, name: s.name, unit: s.unit, desc: s.desc, path: '/storage/' + s.dir, count, updatedAt, note };
    }),
  };
}

async function handleAutoWrite(req, res, route, q) {
  if (route === '/events') {
    const body = await readJsonBody(req, 200000);
    return json(res, 200, handleAlerts(body.alerts));
  }
  const kind = route.startsWith('/schedule') ? 'schedules' : route.startsWith('/rule') ? 'rules' : null;
  if (!kind) throw fail(404, 'not found');
  const list = auto[kind];
  const sub = route.replace(/^\/(schedule|rule)/, '') || '/';
  if (sub === '/') { // 新建或修改
    const body = await readJsonBody(req, 40000);
    const clean = kind === 'schedules' ? cleanSchedule(body) : cleanRule(body);
    let item = body.id ? list.find((x) => x.id === body.id) : null;
    if (body.id && !item) throw fail(404, '这一条已经不存在了');
    if (!item) {
      if (list.length >= 30) throw fail(400, '最多 30 条');
      item = kind === 'schedules' ? { id: newId(), lastRunAt: null, lastTaskId: null } : { id: newId(), fireCount: 0, lastFiredAt: null };
      list.push(item);
    }
    Object.assign(item, clean);
    if (kind === 'schedules') item.nextRunAt = item.enabled ? nextRun(item, Date.now()) : null;
    saveAuto();
    return json(res, 200, { id: item.id });
  }
  const item = list.find((x) => x.id === q.get('id'));
  if (!item) throw fail(404, '这一条已经不存在了');
  if (sub === '/toggle') {
    item.enabled = !item.enabled;
    if (kind === 'schedules') item.nextRunAt = item.enabled ? nextRun(item, Date.now()) : null;
    saveAuto();
    return json(res, 200, { enabled: item.enabled });
  }
  if (sub === '/delete') { list.splice(list.indexOf(item), 1); saveAuto(); return json(res, 200, { ok: true }); }
  if (sub === '/run' && kind === 'schedules') {
    const task = enqueueTask(item.prompt, { type: 'schedule', id: item.id, name: item.name });
    item.lastRunAt = Date.now(); item.lastTaskId = task.id;
    autoLog('schedule', item.name, '手动点了"立即运行"', task.id);
    saveAuto();
    return json(res, 200, { id: task.id });
  }
  throw fail(404, 'not found');
}
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { req.destroy(); reject(fail(413, '内容太长')); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(fail(400, '请求格式不对')); } });
    req.on('error', () => reject(fail(400, '请求中断')));
  });
}
// ---- 给调度台的 CEO Agent 用的模型接口 ----
// 用主人的 Claude 订阅问一次模型：不带任何工具、不读工作目录里的说明和技能，只是一问一答。
const LLM_DIR = '/tmp/ceo-llm';
const LLM_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];
let llmRunning = 0;
function askClaude(model, system, user) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(LLM_DIR, { recursive: true });
    const started = Date.now();
    const child = spawn(CLAUDE_BIN, ['-p', '--model', model, '--system-prompt', system, '--tools', '', '--output-format', 'json',
      '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config'], {
      cwd: LLM_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: AGENT_HOME, USER: 'agent', LOGNAME: 'agent' },
    });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.stdout.on('data', (c) => { if (out.length < 400000) out += c; });
    child.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(fail(502, 'Claude Code 启动失败：' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error || typeof j.result !== 'string' || !j.result.trim()) throw new Error(String(j.result || 'Claude 没有返回内容').slice(0, 200));
        resolve({ text: j.result.trim(), ms: Date.now() - started, model });
      } catch (e) { reject(fail(502, 'Claude 没有答复（' + String(code === null ? '超时' : e.message || err).replace(/\s+/g, ' ').slice(0, 160) + '）')); }
    });
    child.stdin.end(user);
  });
}
// ---- 通话用：先开着待命，问的时候边想边把字送回去 ----
// 临时启动一次 Claude 要一秒多。打电话时等不起，所以提前开好一个等在那里（不提问就不消耗额度），
// 问题一来直接送进去；它每出几个字就马上转给调度台，调度台就能在整段话想完之前先把第一句念出来。
// 每个待命的只回答一句就关掉（不让上一句留在它的记忆里），同时马上再开一个给下一句用；五分钟没人问就关掉不占内存。
const WARM_IDLE_MS = 5 * 60 * 1000;
const warm = new Map();   // 模型 + 系统提示 → 正在待命的那一个
const warmKey = (model, system) => model + ':' + require('crypto').createHash('sha1').update(system).digest('hex');
function warmSpawn(model, system) {
  fs.mkdirSync(LLM_DIR, { recursive: true });
  const child = spawn(CLAUDE_BIN, ['-p', '--model', model, '--system-prompt', system, '--tools', '', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config'], {
    cwd: LLM_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: AGENT_HOME, USER: 'agent', LOGNAME: 'agent' },
  });
  const w = { child, dead: false, timer: null };
  child.on('error', () => { w.dead = true; });
  child.on('close', () => { w.dead = true; });
  child.stdin.on('error', () => { w.dead = true; });
  child.stderr.on('data', () => {});
  return w;
}
const warmKill = (w) => { clearTimeout(w.timer); try { w.child.kill('SIGKILL'); } catch (e) { /* 已经退出 */ } };
function warmKeep(model, system) {
  const key = warmKey(model, system);
  let w = warm.get(key);
  if (!w || w.dead) {
    for (const [k, old] of warm) if (k !== key) { warm.delete(k); warmKill(old); }   // 同时只留一种待命的
    w = warmSpawn(model, system);
    warm.set(key, w);
  }
  clearTimeout(w.timer);
  w.timer = setTimeout(() => { if (warm.get(key) === w) warm.delete(key); warmKill(w); }, WARM_IDLE_MS);
}
function askClaudeStream(model, system, user, res) {
  return new Promise((resolve) => {
    const started = Date.now(), key = warmKey(model, system);
    let w = warm.get(key);
    warm.delete(key);
    if (w) clearTimeout(w.timer);
    const wasWarm = Boolean(w && !w.dead);
    if (!wasWarm) w = warmSpawn(model, system);
    warmKeep(model, system);   // 下一句用的现在就备好
    const child = w.child;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch (e) { /* 对方已经断开 */ } };
    let buf = '', text = '', finished = false;
    const finish = (o) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (o) send(o);
      try { res.end(); } catch (e) { /* 已经断开 */ }
      try { child.kill('SIGKILL'); } catch (e) { /* 已经退出 */ }
      resolve();
    };
    const timer = setTimeout(() => finish({ error: 'Claude 没有答复（超时）' }), 90000);
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let j; try { j = JSON.parse(line); } catch (e) { continue; }
        if (j.type === 'stream_event' && j.event && j.event.type === 'content_block_delta' && j.event.delta && j.event.delta.type === 'text_delta') {
          text += j.event.delta.text; send({ d: j.event.delta.text });
        } else if (j.type === 'result') {
          const full = (text || String(j.result || '')).trim();
          if (j.is_error || !full) finish({ error: 'Claude 没有答复（' + String(j.result || '没有返回内容').replace(/\s+/g, ' ').slice(0, 160) + '）' });
          else finish({ done: true, text: full, ms: Date.now() - started, model, warm: wasWarm });
        }
      }
    });
    child.on('close', () => finish({ error: 'Claude 没有答复（中途退出）' }));
    child.on('error', (e) => finish({ error: 'Claude Code 启动失败：' + e.message }));
    res.on('close', () => finish(null));
    try { child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: user } }) + '\n'); }
    catch (e) { finish({ error: 'Claude 没有答复（送不进去）' }); }
  });
}

// ---- Claude 额度 ----
// 开一个单独的后台 Claude Code 会话（不是主人用的那个终端），输入 /usage，把屏幕上的内容读出来，然后关掉。
// 只是打开界面看一眼，不发任何消息给模型，所以不消耗额度。
const USAGE_EVERY_MS = (Number(process.env.USAGE_REFRESH_MINUTES) || 10) * 60 * 1000;
const USAGE_SESSION = 'usageprobe';
let usage = { at: null, ok: false, error: '正在第一次读取…', plan: '', items: [] };
let usageBusy = false, usageTriedAt = 0;
const tmux = (args) => new Promise((resolve) => execFile('tmux', args, { timeout: 10000, cwd: ROOT, env: { ...process.env, HOME: AGENT_HOME, USER: 'agent', LOGNAME: 'agent' } }, (err, out) => resolve(err ? '' : String(out))));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function parseUsage(text) {
  const lines = String(text).split('\n').map((l) => l.trim());
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^Current (session|week)(?: \((.+)\))?$/.exec(lines[i]);
    if (!m) continue;
    let percent = null, resets = '';
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (/^Current /.test(lines[j])) break;
      const p = /(\d+(?:\.\d+)?)% used/.exec(lines[j]);
      if (p && percent === null) percent = Number(p[1]);
      const r = /^Resets (.+)$/.exec(lines[j]);
      if (r) resets = r[1].replace(/\s*\([^)]*\)\s*$/, '');
    }
    if (percent === null) continue;
    items.push({ label: m[1] === 'session' ? '当前会话' : m[2] && !/all models/i.test(m[2]) ? '本周 · ' + m[2] : '本周 · 全部模型', percent, resets });
  }
  return items;
}
async function refreshUsage() {
  if (usageBusy) return;
  usageBusy = true; usageTriedAt = Date.now();
  try {
    await tmux(['kill-session', '-t', USAGE_SESSION]);
    await tmux(['new-session', '-d', '-s', USAGE_SESSION, '-x', '120', '-y', '50', '-c', ROOT, CLAUDE_BIN]);
    let pane = '';
    for (let i = 0; i < 25 && !/❯/.test(pane); i++) { await pause(1000); pane = await tmux(['capture-pane', '-t', USAGE_SESSION, '-p']); }
    if (!/❯/.test(pane)) throw new Error(/log ?in|sign in/i.test(pane) ? 'Claude Code 还没有登录' : 'Claude Code 没有启动起来');
    const plan = (/·\s*(Claude [A-Za-z0-9 ]+?)\s*$/m.exec(pane) || [])[1] || '';
    await tmux(['send-keys', '-t', USAGE_SESSION, '/usage']);
    await pause(800);
    await tmux(['send-keys', '-t', USAGE_SESSION, 'Enter']);
    let text = '';
    for (let i = 0; i < 20; i++) {
      await pause(1000);
      text = await tmux(['capture-pane', '-t', USAGE_SESSION, '-p']);
      if (/\d% used/.test(text)) { await pause(1200); text = await tmux(['capture-pane', '-t', USAGE_SESSION, '-p']); break; }
    }
    const items = parseUsage(text);
    if (!items.length) throw new Error('/usage 里没有读到额度（这个账号可能不是订阅套餐）');
    usage = { at: Date.now(), ok: true, error: '', plan, items };
  } catch (e) {
    usage = { ...usage, ok: false, error: String(e.message || e), errorAt: Date.now() };
  } finally {
    await tmux(['kill-session', '-t', USAGE_SESSION]);
    usageBusy = false;
  }
}
setInterval(refreshUsage, USAGE_EVERY_MS);
setTimeout(refreshUsage, 8000);

async function handleTasks(req, res, url) {
  const route = url.pathname.slice(TASK_BASE.length) || '/';
  const q = url.searchParams;
  if (req.method === 'GET' && (route === '/' || route === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(readTaskPage());
  }
  if (req.method === 'GET' && route === '/api/list') {
    return json(res, 200, { tasks: tasks.slice().sort((a, b) => b.createdAt - a.createdAt).map(taskSummary) });
  }
  if (req.method === 'GET' && route === '/api/get') {
    const t = tasks.find((x) => x.id === q.get('id'));
    if (!t) throw fail(404, '任务不存在');
    const { resumeSession, ...pub } = t;
    return json(res, 200, { ...pub, canContinue: Boolean(t.sessionId) && t.status !== 'running' && t.status !== 'queued' });
  }
  if (req.method === 'GET' && route === '/auto') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(readPage('auto-page.html'));
  }
  if (req.method === 'GET' && route === '/api/usage') return json(res, 200, { ...usage, refreshing: usageBusy, everyMinutes: USAGE_EVERY_MS / 60000 });
  if (req.method === 'GET' && route === '/market') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(readPage('market-page.html'));
  }
  if (req.method === 'GET' && route.startsWith('/api/market/')) return json(res, 200, await market.get(route.slice('/api/market'.length), q));
  if (req.method === 'GET' && route === '/api/auto/summary') return json(res, 200, autoSummary());
  if (req.method === 'GET' && route === '/api/storage') return json(res, 200, storageSummary());
  if (req.method === 'GET' && route === '/components') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(readPage('components-page.html'));
  }
  if (req.method === 'GET' && route === '/api/components') return json(res, 200, componentList());
  if (req.method === 'GET' && route === '/api/components/file') return componentFile(res, q.get('id'), q.get('f'));
  if (req.method !== 'POST') throw fail(405, 'method not allowed');
  if (req.headers['x-files-action'] !== '1') throw fail(403, '请求来源不对');

  if (route === '/api/create') {
    const body = await readJsonBody(req, 40000);
    return json(res, 200, { id: enqueueTask(body.prompt, null, body.continueFrom).id });
  }
  if (route === '/api/llm') {
    const body = await readJsonBody(req, 200000);
    const model = LLM_MODELS.includes(body.model) ? body.model : null;
    if (!model) throw fail(400, '不支持这个模型');
    if (typeof body.system !== 'string' || typeof body.user !== 'string' || !body.user.trim() || body.system.length > 20000) throw fail(400, '内容不对');
    if (llmRunning >= 3) throw fail(429, '同时在问的太多了，稍后再试');
    llmRunning++;
    try { return json(res, 200, await askClaude(model, body.system, body.user)); } finally { llmRunning--; }
  }
  if (route === '/api/llm/warm' || route === '/api/llm/stream') {
    const body = await readJsonBody(req, 200000);
    const model = LLM_MODELS.includes(body.model) ? body.model : null;
    if (!model) throw fail(400, '不支持这个模型');
    if (typeof body.system !== 'string' || !body.system || body.system.length > 20000) throw fail(400, '内容不对');
    if (route === '/api/llm/warm') { warmKeep(model, body.system); return json(res, 200, { ok: true }); }
    if (typeof body.user !== 'string' || !body.user.trim()) throw fail(400, '内容不对');
    if (llmRunning >= 3) throw fail(429, '同时在问的太多了，稍后再试');
    llmRunning++;
    try { return await askClaudeStream(model, body.system, body.user, res); } finally { llmRunning--; }
  }
  if (route === '/api/usage/refresh') {
    if (!usageBusy && Date.now() - usageTriedAt < 30000) throw fail(429, '刚刷新过，过半分钟再点');
    refreshUsage();
    return json(res, 200, { ok: true });
  }
  if (route === '/api/ext/apply') return json(res, 200, await applyExt(market, await readJsonBody(req, 200000)));
  if (route.startsWith('/api/market/')) return json(res, 200, await market.post(route.slice('/api/market'.length), await readJsonBody(req, 40000)));
  if (route.startsWith('/api/auto/')) return handleAutoWrite(req, res, route.slice('/api/auto'.length), q);
  const t = tasks.find((x) => x.id === q.get('id'));
  if (!t) throw fail(404, '任务不存在');
  if (route === '/api/stop') {
    if (t.status === 'queued') { t.status = 'stopped'; t.error = '还没开始就被取消了'; t.endedAt = Date.now(); saveTasks(); }
    else if (t.status === 'running' && current && current.task === t) { t.stopReason = '被手动停止'; killTree(current.child); }
    return json(res, 200, { ok: true });
  }
  if (route === '/api/delete') {
    if (t.status === 'running' || t.status === 'queued') throw fail(400, '任务还在进行，先停止再删除');
    tasks.splice(tasks.indexOf(t), 1);
    saveTasks();
    return json(res, 200, { ok: true });
  }
  throw fail(404, 'not found');
}
setTimeout(pump, 1000); // 启动时接着处理上次没来得及开始的排队任务

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === TASK_BASE || url.pathname.startsWith(TASK_BASE + '/')) return handleTasks(req, res, url);
  if (!url.pathname.startsWith(BASE)) throw fail(404, 'not found');
  const route = url.pathname.slice(BASE.length) || '/';
  const q = url.searchParams;

  if (req.method === 'GET' && (route === '/' || route === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(readPage('files-page.html'));
  }
  if (req.method === 'GET' && route === '/api/list') {
    const { abs, rel } = await resolveSafe(q.get('path'));
    const names = await fsp.readdir(abs).catch((e) => { throw fail(e.code === 'ENOENT' ? 404 : 400, e.code === 'ENOENT' ? '这个文件夹不存在' : '这不是一个文件夹'); });
    const items = [];
    for (const name of names) {
      try {
        const st = await fsp.stat(path.join(abs, name));
        items.push({ name, dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: st.mtimeMs });
      } catch (e) { items.push({ name, dir: false, size: null, mtime: null, broken: true }); }
    }
    items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'));
    return json(res, 200, { path: rel, items });
  }
  // 多选下载：把同一个文件夹里选中的若干项打成一个 zip。
  if (req.method === 'GET' && route === '/api/zip') {
    const dir = await resolveSafe(q.get('path'));
    const names = q.getAll('name').map(checkName);
    if (!names.length || names.length > 500) throw fail(400, '没有选中任何文件');
    for (const n of names) {
      const t = await resolveSafe(path.posix.join(dir.rel, n));
      if (!fs.existsSync(t.abs)) throw fail(404, n + ' 已经不存在了');
    }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': attachment((dir.abs === ROOT ? 'workspace' : path.basename(dir.abs)) + '-已选' + names.length + '项.zip') });
    const zip = spawn('zip', ['-r', '-q', '-', '--', ...names], { cwd: dir.abs }); // "--" 之后的都当作文件名，名字以 - 开头也不会被当成参数
    zip.stdout.pipe(res);
    zip.on('error', () => res.destroy());
    req.on('close', () => zip.kill());
    return;
  }
  if (req.method === 'GET' && route === '/api/download') {
    const { abs, rel } = await resolveSafe(q.get('path'));
    const st = await fsp.stat(abs).catch(() => { throw fail(404, '文件不存在'); });
    if (st.isDirectory()) {
      // 文件夹打成 zip 再下载。
      const isRoot = abs === ROOT;
      const name = isRoot ? 'workspace' : path.basename(abs);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': attachment(name + '.zip') });
      const zip = spawn('zip', ['-r', '-q', '-', isRoot ? '.' : name], { cwd: isRoot ? ROOT : path.dirname(abs) });
      zip.stdout.pipe(res);
      zip.on('error', () => res.destroy());
      req.on('close', () => zip.kill());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': attachment(path.basename(rel)) });
    return fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
  }

  // 在线查看/编辑：读出文本内容。太大的、或者不是文本的文件不读内容，只告诉页面"这个不能在线编辑"。
  if (req.method === 'GET' && route === '/api/read') {
    const { abs, rel } = await resolveSafe(q.get('path'));
    const st = await fsp.stat(abs).catch(() => { throw fail(404, '文件不存在'); });
    if (st.isDirectory()) throw fail(400, '这是一个文件夹');
    const info = { path: rel, name: path.basename(rel), size: st.size, mtime: st.mtimeMs };
    if (st.size > MAX_EDIT) return json(res, 200, { ...info, tooBig: true });
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return json(res, 200, { ...info, binary: true });
    return json(res, 200, { ...info, text: buf.toString('utf8') });
  }
  // 图片预览：只对图片类型原样输出，并且带上"沙箱"安全头，
  // 这样即使文件里藏了脚本（比如 SVG），在浏览器里直接打开这个地址也不会被执行。
  if (req.method === 'GET' && route === '/api/raw') {
    const { abs } = await resolveSafe(q.get('path'));
    const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
    if (!type) throw fail(415, '这种文件不能在线预览');
    const st = await fsp.stat(abs).catch(() => { throw fail(404, '文件不存在'); });
    if (st.isDirectory()) throw fail(400, '这是一个文件夹');
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    });
    return fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
  }

  // 下面都是会改动文件的操作：只接受 POST，并要求带自定义请求头（别的网站无法伪造）。
  if (req.method !== 'POST') throw fail(405, 'method not allowed');
  if (req.headers['x-files-action'] !== '1') throw fail(403, '请求来源不对');

  if (route === '/api/upload') {
    const dir = await resolveSafe(q.get('path'));
    const name = checkName(q.get('name'));
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) throw fail(413, '文件超过 5 GB');
    const target = (await resolveSafe(path.posix.join(dir.rel, name))).abs;
    const tmp = path.join(dir.abs, `.${name}.uploading-${Date.now().toString(36)}`);
    await new Promise((resolve, reject) => {
      let size = 0;
      const out = fs.createWriteStream(tmp);
      req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) { req.destroy(); out.destroy(); reject(fail(413, '文件超过 5 GB')); } });
      req.on('aborted', () => { out.destroy(); reject(fail(400, '上传中断')); });
      out.on('error', (e) => reject(fail(500, '写入失败：' + e.code)));
      out.on('finish', resolve);
      req.pipe(out);
    }).catch(async (e) => { await fsp.rm(tmp, { force: true }); throw e; });
    await fsp.rename(tmp, target);
    return json(res, 200, { ok: true });
  }
  // 保存文本文件（在线编辑、新建文件）。
  // mtime：页面打开文件时记下的修改时间。保存时如果文件已经被别人（通常是 Agent）改过，就不覆盖，
  // 让主人决定；带 force=1 才强行覆盖。create=1 表示新建，文件已存在就拒绝。
  if (route === '/api/write') {
    const t = await resolveSafe(q.get('path'));
    if (t.abs === ROOT) throw fail(400, '路径不合法');
    checkName(path.basename(t.abs));
    const parent = await fsp.stat(path.dirname(t.abs)).catch(() => null);
    if (!parent || !parent.isDirectory()) throw fail(400, '所在的文件夹不存在');
    const cur = await fsp.stat(t.abs).catch(() => null);
    if (cur && cur.isDirectory()) throw fail(400, '已经有同名的文件夹');
    if (q.get('create') === '1' && cur) throw fail(400, '已经有同名的文件');
    const seen = Number(q.get('mtime'));
    if (cur && seen && q.get('force') !== '1' && Math.abs(cur.mtimeMs - seen) > 2) {
      return json(res, 409, { error: '这个文件在你打开之后被改动过（可能是 Agent 改的）', conflict: true, mtime: cur.mtimeMs });
    }
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      req.on('data', (c) => { size += c.length; if (size > MAX_EDIT) { req.destroy(); reject(fail(413, '内容超过 ' + (MAX_EDIT / 1048576) + ' MB，不能在线保存')); } else chunks.push(c); });
      req.on('end', resolve);
      req.on('error', () => reject(fail(400, '保存中断')));
    });
    const tmp = path.join(path.dirname(t.abs), '.' + path.basename(t.abs) + '.saving-' + Date.now().toString(36));
    try {
      await fsp.writeFile(tmp, Buffer.concat(chunks), cur ? { mode: cur.mode } : undefined);
      await fsp.rename(tmp, t.abs);
    } catch (e) { await fsp.rm(tmp, { force: true }); throw fail(500, '保存失败：' + e.code); }
    const st = await fsp.stat(t.abs);
    return json(res, 200, { ok: true, mtime: st.mtimeMs, size: st.size });
  }
  if (route === '/api/mkdir') {
    const dir = await resolveSafe(q.get('path'));
    const target = (await resolveSafe(path.posix.join(dir.rel, checkName(q.get('name'))))).abs;
    await fsp.mkdir(target).catch((e) => { throw fail(400, e.code === 'EEXIST' ? '已经有同名的文件或文件夹' : '新建失败：' + e.code); });
    return json(res, 200, { ok: true });
  }
  if (route === '/api/rename') {
    const from = await resolveSafe(q.get('path'));
    if (from.abs === ROOT) throw fail(400, '不能改工作目录本身');
    const to = (await resolveSafe(path.posix.join(path.posix.dirname(from.rel), checkName(q.get('name'))))).abs;
    if (fs.existsSync(to)) throw fail(400, '已经有同名的文件或文件夹');
    await fsp.rename(from.abs, to).catch((e) => { throw fail(400, '改名失败：' + e.code); });
    return json(res, 200, { ok: true });
  }
  if (route === '/api/delete') {
    const t = await resolveSafe(q.get('path'));
    if (t.abs === ROOT) throw fail(400, '不能删除工作目录本身');
    await fsp.rm(t.abs, { recursive: true, force: false }).catch((e) => { throw fail(400, e.code === 'ENOENT' ? '文件已经不存在' : '删除失败：' + e.code); });
    return json(res, 200, { ok: true });
  }
  throw fail(404, 'not found');
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) return res.destroy();
    json(res, e.status || 500, { error: e.status ? e.message : '服务器内部错误' });
    if (!e.status) console.error(e);
  });
}).listen(PORT, '0.0.0.0', () => console.log(`files server on ${PORT}, root ${ROOT}`));
