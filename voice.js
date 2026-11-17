// 和 CEO Agent 说话：主人在首页点"点击说话"，录音转成文字后交给 CEO Agent，
// CEO Agent 决定是自己回答、交给专用 Agent，还是交给某个 Bot；交出去的事做完后把结果带回这段对话。
// 这里只负责"派活"：专用 Agent 要动服务器时照旧走审批，这里不替任何人批准任何事。
const fs = require('fs');

module.exports = function (ctx) {
  const { ceoCall, state, note, botsUrl, tasksUrl, sttUrl, file } = ctx;
  let log = [];
  try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* 还没有对话 */ }
  let seq = log.reduce((m, x) => Math.max(m, x.id || 0), 0);
  let busy = false;
  const save = () => { try { fs.writeFileSync(file + '.tmp', JSON.stringify(log)); fs.renameSync(file + '.tmp', file); } catch (e) { /* 存不了不影响使用 */ } };
  const push = (m) => { const it = { id: ++seq, at: Date.now(), ...m }; log.push(it); if (log.length > 80) log = log.slice(-80); save(); return it; };
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…（后面还有，去对应的页面看全文）' : s; };

  async function call(url, body, header, timeout) {
    const res = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', [header]: '1' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout || 10000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.error || '返回 ' + res.status); e.status = res.status; throw e; }
    return j;
  }
  const bots = (p, b) => call(botsUrl + p, b, 'X-Bots-Action');
  const tasks = (p, b) => call(tasksUrl + p, b, 'X-Files-Action');

  const PROMPT = `你是 CEO Agent。主人（站长）正在调度台上对你说话。文字多半是语音识别出来的，可能有同音错字，按意思理解；实在听不明白就问他，不要猜着派活。
你的工作是决定这句话由谁来办。只输出一个 JSON，不要输出别的：
{"action":"reply 或 agent 或 bot","bot":"Bot 的名字，action 是 bot 时才填","followUp":false,"task":"交给对方的任务说明","say":"对主人说的一句话"}

三种做法：
- reply：你自己直接回答。适用于：问现在的运行情况（只用下面给你的监控数据回答，不要编造）、闲聊、问你能做什么、或者你需要先问清楚再派活。这时 say 就是你的回答，最多 200 字，task 留空。
- agent：交给专用 Agent。它是一台有完整开发环境的 Linux 电脑上的 Claude，能写代码、处理文件、查资料、发邮件、发布网页；需要在主人的服务器上执行命令时会另外走审批。适合要分好几步完成的正事、写程序、和主人的服务器或文件有关的事。
- bot：交给某个 Bot。Bot 有一台带浏览器和桌面的电脑，适合上网查东西、打开网页截图、画图出图、轻量的问答和杂事。从下面的 Bot 名单里按名字选一个；名单是空的或者都不合适就用 agent。主人点名要某个 Bot 时照办。

task 怎么写：把主人的要求完整、清楚地转述成一段任务说明，纠正明显的识别错字，补上从上文对话里能确定的指代（"刚才那个""它"）。不要添加主人没有提的要求，不要替他做他没做的决定。
followUp：主人这句话是在接着上一件已经交给专用 Agent 的事往下说（修改、补充、追问）时填 true，这样会在原来那个任务的基础上继续；否则填 false。
action 是 agent 或 bot 时，say 用一句话告诉主人交给了谁、去做什么，不超过 60 字。
主人要求的事明显会造成破坏（删数据、关停线上业务之类）时先不要派出去，用 reply 向他确认一遍。
不要用 Markdown。
如果给你的数据里"正在通话"是 true：主人正在和你打语音电话，say 会被直接念给他听。这时 say 要像打电话一样口语化、简短（一般不超过 50 字），不要出现网址、代码、符号和列表，数字和英文名照常说。`;
  const SPEAK_PROMPT = '你是 CEO Agent，正在和主人打语音电话。下属把一件事的结果交回来了，你要把结果口头转告主人。只输出要说的话本身：口语化，不超过 80 字，先说谁做完了（或没做成），再说最要紧的结论；不要念网址、代码、符号和列表，有文件或链接就说"详细的在通话记录里"。';
  // 念之前把网址和排版符号去掉。
  const forSpeech = (s) => String(s || '').replace(/https?:[^ \n）)]+/g, '链接').replace(/[*_#`>|~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
  async function summarize(it) {
    let speak = '';
    try { speak = forSpeech((await ceoCall(SPEAK_PROMPT, JSON.stringify({ 谁: it.from, 做成了: it.ok, 结果: clip(it.text, 3000) }), 300)).text).slice(0, 240); } catch (e) { /* 说不出来就用下面那句 */ }
    it.speak = speak || (it.from + (it.ok ? '做完了' : '没有做成') + '，详细的在通话记录里。');
    save();
  }

  function parse(text) {
    try {
      const j = JSON.parse(String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1));
      const action = ['reply', 'agent', 'bot'].includes(j.action) ? j.action : null;
      if (!action) return null;
      return { action, bot: String(j.bot || '').trim(), followUp: j.followUp === true, task: String(j.task || '').trim().slice(0, 6000), say: String(j.say || '').trim().slice(0, 600) };
    } catch (e) { return null; }
  }

  async function decide(text, inCall) {
    let botList = [], botErr = '';
    try { botList = (await bots('/api/state')).bots || []; } catch (e) { botErr = 'Bot 那边现在连不上'; }
    const input = {
      主人说: text,
      正在通话: Boolean(inCall),
      最近的对话: log.slice(-9, -1).map((m) => ({ 谁: m.role === 'me' ? '主人' : m.role === 'result' ? m.from + '的结果' : 'CEO Agent' + (m.to ? '（交给了' + m.to + '）' : ''), 内容: clip(m.task || m.text, 400) })),
      Bot名单: botList.map((b) => ({ 名字: b.name, 设定: String(b.persona || '').slice(0, 120), 正在忙: Boolean(b.running) })),
      Bot情况: botErr || undefined,
      监控数据: ctx.briefInput ? ctx.briefInput() : undefined,
      当前简报: state.brief && state.brief.text ? state.brief.text : undefined,
    };
    const r = await ceoCall(PROMPT, JSON.stringify(input), 900);
    const out = parse(r.text);
    if (!out) return { action: 'reply', say: r.text.replace(/\s+/g, ' ').slice(0, 400), botList };
    return { ...out, botList };
  }

  async function handleSay(text, inCall) {
    busy = true;
    try {
      const d = await decide(text, inCall);
      if (d.action === 'bot') {
        const want = d.bot.toLowerCase();
        const bot = d.botList.find((b) => b.name.toLowerCase() === want) || (want && d.botList.find((b) => b.name.toLowerCase().includes(want)));
        if (!bot) d.action = 'agent';   // 没有这个 Bot：改交给专用 Agent
        else if (bot.running) return push({ role: 'ceo', text: '这件事适合交给「' + bot.name + '」，但它正在忙别的。等它做完再说一遍，或者告诉我换一个人做。' });
        else {
          const before = (await bots('/api/chat?bot=' + bot.id + '&since=0')).messages.reduce((m, x) => Math.max(m, x.id), 0);
          await bots('/api/send', { bot: bot.id, text: '【主人通过 CEO Agent 交代的事】\n' + (d.task || text) });
          note({ verdict: 'dispatch', who: '', what: '主人口头交代的事，交给了 Bot「' + bot.name + '」', reason: (d.task || text).slice(0, 120) });
          return push({ role: 'ceo', text: d.say || '已经交给「' + bot.name + '」。', to: 'Bot「' + bot.name + '」', task: d.task || text, ref: { kind: 'bot', id: bot.id, name: bot.name, before }, state: 'running' });
        }
      }
      if (d.action === 'agent') {
        if (!tasksUrl) return push({ role: 'ceo', text: '专用 Agent 没有接入，这件事派不出去。' });
        const prompt = (d.task || text).slice(0, 7900);
        const prev = d.followUp ? log.slice().reverse().find((m) => m.ref && m.ref.kind === 'agent' && m.state !== 'running') : null;
        let made = null;
        if (prev) made = await tasks('/api/create', { prompt, continueFrom: prev.ref.id }).catch(() => null);   // 接不上就当一件新的事
        const continued = Boolean(made);
        if (!made) made = await tasks('/api/create', { prompt });
        note({ verdict: 'dispatch', who: '', what: '主人口头交代的事，交给了专用 Agent' + (continued ? '（接着上一件继续）' : ''), reason: prompt.slice(0, 120) });
        return push({ role: 'ceo', text: d.say || '已经交给专用 Agent。', to: '专用 Agent', task: prompt, ref: { kind: 'agent', id: made.id }, state: 'running' });
      }
      return push({ role: 'ceo', text: d.say || '我没有想好怎么回答，换个说法再说一遍。' });
    } catch (e) {
      return push({ role: 'ceo', text: '这句话没有处理成：' + String(e.message || e).slice(0, 160), failed: true });
    } finally { busy = false; }
  }

  // 交出去的事做完没有：做完就把结果带回对话里。
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const m of log.filter((x) => x.state === 'running' && x.ref)) {
        const done = (ok, text) => { m.state = ok ? 'done' : 'failed'; summarize(push({ role: 'result', from: m.to, ok, text: clip(text, 1500), kind: m.ref.kind })); };
        try {
          if (Date.now() - m.at > 3 * 3600000) { m.state = 'unknown'; save(); continue; }   // 太久了就不再盯着
          if (m.ref.kind === 'agent') {
            const t = await tasks('/api/get?id=' + encodeURIComponent(m.ref.id));
            if (t.status === 'done') done(true, t.result || '做完了（没有文字说明）');
            else if (t.status === 'failed' || t.status === 'stopped') done(false, t.error || '任务没有做成');
          } else {
            const c = await bots('/api/chat?bot=' + m.ref.id + '&since=' + m.ref.before);
            if (c.running) continue;
            const finals = c.messages.filter((x) => x.role === 'assistant' && !(x.calls && x.calls.length));
            const last = finals[finals.length - 1];
            if (!last) { if (Date.now() - m.at > 30000) done(false, '它没有给出回答'); continue; }
            done(!last.error, last.text);
          }
        } catch (e) {
          if (e.status === 404) { m.state = 'unknown'; save(); }   // 任务记录或 Bot 已经被删掉
        }
      }
    } finally { ticking = false; }
  }

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const readRaw = (req, max) => new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('内容太大')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

  async function handle(req, res, pathname) {
    try {
      const route = pathname.slice('/api/voice'.length);
      if (req.method === 'GET' && route === '/log') return json(res, 200, { items: log.slice(-60), busy });
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      if (req.headers['x-voice-action'] !== '1') return json(res, 403, { error: '请求来源不对' });
      if (route === '/stt') {
        const audio = await readRaw(req, 12 * 1024 * 1024);
        if (audio.length < 800) return json(res, 400, { error: '录音是空的' });
        let r;
        try { r = await fetch(sttUrl, { method: 'POST', body: audio, signal: AbortSignal.timeout(90000) }); }
        catch (e) { return json(res, 502, { error: '语音识别服务没有回应' }); }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return json(res, 502, { error: j.error || '语音识别出错' });
        return json(res, 200, { text: String(j.text || '').trim(), seconds: j.seconds });
      }
      if (route === '/say') {
        const body = JSON.parse((await readRaw(req, 20000)).toString('utf8') || '{}');
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: '内容是空的' });
        if (text.length > 2000) return json(res, 400, { error: '太长了（最多 2000 字）' });
        if (busy) return json(res, 409, { error: 'CEO Agent 还在处理上一句，等一下再发' });
        push({ role: 'me', text });
        handleSay(text, body.call === true);   // 不等它：页面会自己来取结果
        return json(res, 200, { ok: true });
      }
      if (route === '/tts') {
        const body = JSON.parse((await readRaw(req, 20000)).toString('utf8') || '{}');
        const text = forSpeech(body.text);
        if (!text) return json(res, 400, { error: '没有要念的内容' });
        let r;
        try { r = await fetch(sttUrl + 'tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(60000) }); }
        catch (e) { return json(res, 502, { error: '语音合成服务没有回应' }); }
        if (!r.ok) return json(res, 502, { error: '语音合成出错' });
        res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'audio/wav', 'Cache-Control': 'no-store' });
        return res.end(Buffer.from(await r.arrayBuffer()));
      }
      if (route === '/clear') { log = log.filter((m) => m.state === 'running'); save(); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'not found' });
    } catch (e) { return json(res, 400, { error: String(e.message || e).slice(0, 160) }); }
  }

  return { handle, tick };
};
