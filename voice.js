// 和 CEO Agent 说话：主人在首页点"点击说话"，录音转成文字后交给 CEO Agent，
// CEO Agent 决定是自己回答、交给专用 Agent，还是交给某个 Bot；交出去的事做完后把结果带回这段对话。
// 这里只负责"派活"：专用 Agent 要动服务器时照旧走审批，这里不替任何人批准任何事。
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

module.exports = function (ctx) {
  const { ceoCall, state, note, botsUrl, tasksUrl, sttUrl, file } = ctx;
  let log = [];
  try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* 还没有对话 */ }
  let seq = log.reduce((m, x) => Math.max(m, x.id || 0), 0);
  let busy = false;
  const save = () => { try { fs.writeFileSync(file + '.tmp', JSON.stringify(log)); fs.renameSync(file + '.tmp', file); } catch (e) { /* 存不了不影响使用 */ } };
  const push = (m) => { const it = { id: ++seq, at: Date.now(), ...m }; log.push(it); if (log.length > 80) log = log.slice(-80); save(); return it; };
  // ---- 语音识别用哪一家 ----
  // 默认用本机的小模型。主人在页面上填了火山引擎（豆包语音）的密钥并打开开关后，就改用豆包的大模型来识别；
  // 豆包那边出任何问题（密钥不对、欠费、超时），这一句自动退回本机模型，电话不会断。密钥只存在这个文件里，不写进日志，也不发回页面。
  let asr = { enabled: false, stream: true, mode: 'new', apiKey: '', appId: '', accessToken: '', hotwords: [] };
  try { asr = { ...asr, ...JSON.parse(fs.readFileSync(ctx.asrFile, 'utf8')) }; } catch (e) { /* 还没设置过 */ }
  const asrState = { lastOk: 0, lastError: '', lastErrorAt: 0, wordsOk: true, streamRes: '', streamWords: true };
  const asrHasKey = () => (asr.mode === 'new' ? Boolean(asr.apiKey) : Boolean(asr.appId && asr.accessToken));
  const asrReady = () => Boolean(asr.enabled && ctx.asrFile && asrHasKey());
  const saveAsr = () => { fs.writeFileSync(ctx.asrFile + '.tmp', JSON.stringify(asr), { mode: 0o600 }); fs.renameSync(ctx.asrFile + '.tmp', ctx.asrFile); };
  const tail = (v) => (v ? '…' + String(v).slice(-4) : '');
  const asrView = () => ({ enabled: asr.enabled, mode: asr.mode, hasKey: asrHasKey(), keyTail: asr.mode === 'new' ? tail(asr.apiKey) : tail(asr.accessToken), appId: asr.mode === 'old' ? asr.appId : '', hotwords: asr.hotwords, stream: asr.stream !== false, ...asrState });
  // 火山引擎"大模型录音文件极速版识别"：一次请求直接返回文字。自定义词随请求一起带过去。
  async function doubao(audio, format, useWords = true) {
    const request = { model_name: 'bigmodel', enable_itn: true, enable_punc: true };
    if (useWords && asr.hotwords.length) request.context = JSON.stringify({ hotwords: asr.hotwords.map((word) => ({ word })) });
    const res = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Request-Id': crypto.randomUUID(), 'X-Api-Sequence': '-1',
        ...(asr.mode === 'new' ? { 'X-Api-Key': asr.apiKey } : { 'X-Api-App-Key': asr.appId, 'X-Api-Access-Key': asr.accessToken }) },
      body: JSON.stringify({ user: { uid: 'dispatch' }, audio: { data: audio.toString('base64'), format }, request }),
      signal: AbortSignal.timeout(20000),
    });
    const code = res.headers.get('x-api-status-code') || '', msg = res.headers.get('x-api-message') || '';
    const j = await res.json().catch(() => ({}));
    if (code === '20000003' || code === '45000002') return '';   // 静音、空音频：就是没听到话
    if (code !== '20000000') {
      // 带着自定义词被说"参数无效"：可能是这个接口不收自定义词，去掉再试一次。
      if (useWords && request.context && code === '45000001') { asrState.wordsOk = false; return doubao(audio, format, false); }
      const why = res.status === 401 || res.status === 403 ? '密钥不对，或者这个密钥没有开通"录音文件极速版识别"' : code === '55000031' ? '豆包那边太忙' : (msg || j.message || JSON.stringify(j)).slice(0, 100);
      throw new Error(`豆包返回 ${code || res.status}：${why}`);
    }
    if (useWords && request.context) asrState.wordsOk = true;
    return String((j.result && j.result.text) || '').trim();
  }
  // ---- 流式识别（边说边出字）----
  // 页面把正在说的话每 0.2 秒传来一小段，这里通过一条和豆包之间的长连接转过去，豆包一边听一边把认出来的字传回来，
  // 并且由它来判断这句话说完了没有。一句话用一条连接，说完就断开；停顿的时候不传任何声音。
  // 豆包的流式接口用的是它自己的二进制格式：4 个字节的头，接着是内容的长度，再接着是压缩过的内容。
  const authHeaders = () => (asr.mode === 'new' ? { 'X-Api-Key': asr.apiKey } : { 'X-Api-App-Key': asr.appId, 'X-Api-Access-Key': asr.accessToken });
  const streams = new Map();
  const frame = (type, flags, json, payload) => {
    const z = zlib.gzipSync(payload), n = Buffer.alloc(4);
    n.writeUInt32BE(z.length);
    return Buffer.concat([Buffer.from([0x11, (type << 4) | flags, ((json ? 1 : 0) << 4) | 1, 0]), n, z]);
  };
  function parseFrame(buf) {
    const type = buf[1] >> 4, flags = buf[1] & 15, gz = (buf[2] & 15) === 1, head = (buf[0] & 15) * 4;
    const body = (o) => { const n = buf.readUInt32BE(o), p = buf.subarray(o + 4, o + 4 + n); return gz ? zlib.gunzipSync(p) : p; };
    if (type === 15) {   // 豆包报错：错误码 + 说明
      let msg = '';
      try { msg = body(head + 4).toString('utf8'); } catch (e) { msg = buf.subarray(head + 8).toString('utf8'); }
      return { error: buf.readUInt32BE(head) + '：' + msg.replace(/\s+/g, ' ').slice(0, 160), code: buf.readUInt32BE(head) };
    }
    if (type !== 9) return {};
    // 结果：头后面可能先跟着 4 个字节的序号。按标志位判断；万一对不上，再按另一种摆法试一次。
    for (const o of flags & 1 ? [head + 4, head] : [head, head + 4]) {
      try { return { final: Boolean(flags & 2), json: JSON.parse(body(o).toString('utf8') || '{}') }; } catch (e) { /* 换一种摆法 */ }
    }
    return {};
  }
  function openStream(sid, format) {
    const s = { ws: null, open: false, pending: [], text: '', definite: false, final: false, error: '', at: Date.now(), waiters: [] };
    streams.set(sid, s);
    const wake = () => { for (const w of s.waiters.splice(0)) w(); };
    const fail = (msg, code) => {
      if (s.error || s.final || s.done) return;   // 已经收尾的那条连接再断开，不算出错
      s.error = msg;
      if (code === 45000001 && asrState.streamWords && asr.hotwords.length) asrState.streamWords = false;   // 多半是不收自定义词：下一句不带了
      asrState.lastError = '流式识别：' + msg; asrState.lastErrorAt = Date.now();
      console.log('[语音识别] 流式这一句没成：' + msg);
      try { s.ws.close(); } catch (e) { /* 已经断了 */ }
      wake();
    };
    s.fail = fail;
    // 新版模型（2.0）和旧版模型用的是两个不同的资源编号：先试上次连上的那个，握手被拒就换另一个。
    const ids = ['volc.seedasr.sauc.duration', 'volc.bigasr.sauc.duration'];
    const order = asrState.streamRes === ids[1] ? [ids[1], ids[0]] : ids;
    const connect = (i) => {
      let opened = false;
      const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', { headers: { ...authHeaders(), 'X-Api-Resource-Id': order[i], 'X-Api-Connect-Id': crypto.randomUUID() } });
      ws.binaryType = 'arraybuffer';
      s.ws = ws;
      ws.onopen = () => {
        if (s.ws !== ws) return;
        opened = true; s.open = true; asrState.streamRes = order[i];
        // 自定义词：流式接口只收很少的词，挑排在前面的，总长度控制在 60 个字以内。
        const words = [];
        let len = 0;
        for (const w of asr.hotwords) { if (len + w.length > 60) break; words.push(w); len += w.length; }
        const request = { model_name: 'bigmodel', enable_itn: true, enable_punc: true, show_utterances: true, result_type: 'full', enable_nonstream: true, end_window_size: 1000 };
        if (words.length && asrState.streamWords) request.corpus = { context: JSON.stringify({ hotwords: words.map((word) => ({ word })) }) };
        ws.send(frame(1, 0, true, Buffer.from(JSON.stringify({ user: { uid: 'dispatch' }, audio: { format: format || 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 }, request }))));
        for (const b of s.pending.splice(0)) ws.send(b);
      };
      ws.onmessage = (e) => {
        if (s.ws !== ws) return;
        let r;
        try { r = parseFrame(Buffer.from(e.data)); } catch (err) { return; }
        if (r.error) return fail(r.error, r.code);
        if (!r.json) return;
        const out = r.json.result || {};
        if (typeof out.text === 'string') s.text = out.text.trim();
        if ((out.utterances || []).some((u) => u && u.definite)) s.definite = true;
        if (r.final) s.final = true;
        wake();
      };
      ws.onerror = () => {
        if (s.ws !== ws) return;
        if (!opened && i + 1 < order.length) return connect(i + 1);
        if (!opened) asrState.streamDownUntil = Date.now() + 10 * 60000;   // 握手都过不去：十分钟内不再试流式，直接用整句识别，免得每句话都白等
        fail(opened ? '和豆包的连接断了' : '连不上豆包的流式识别：密钥不对，或者没有开通"流式语音识别模型"');
      };
      ws.onclose = () => { if (s.ws !== ws) return; if (opened && !s.error) s.final = true; wake(); };
    };
    connect(0);
    return s;
  }
  const endStream = (sid) => { const s = streams.get(sid); if (!s) return; s.done = true; streams.delete(sid); try { s.ws.close(); } catch (e) { /* 已经断了 */ } };
  setInterval(() => { for (const [sid, s] of streams) if (Date.now() - s.at > 20000) endStream(sid); }, 10000).unref();
  // 往一条流里送一段声音；last 表示这句话说完了，等豆包给出最后的结果（最多等几秒）。
  async function pushStream(sid, pcm, last, format) {
    const s = streams.get(sid) || openStream(sid, format);
    s.at = Date.now();
    if (!s.error && !s.final && (pcm.length || last)) {
      const b = frame(2, last ? 2 : 0, false, pcm);
      if (s.open) { try { s.ws.send(b); } catch (e) { s.fail('和豆包的连接断了'); } } else s.pending.push(b);
    }
    if (last && !s.error && !s.final) await new Promise((r) => { s.waiters.push(r); setTimeout(r, 5000); });
    const out = { text: s.text, definite: s.definite, final: s.final, error: s.error };
    if (last || s.error || s.definite || s.final) {
      if (!s.error) { asrState.lastOk = Date.now(); asrState.lastError = ''; }
      endStream(sid);
    }
    return out;
  }
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…（后面还有，去对应的页面看全文）' : s; };

  async function call(url, body, header, timeout) {
    const res = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', [header]: '1' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout || 10000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.error || '返回 ' + res.status); e.status = res.status; throw e; }
    return j;
  }
  const bots = (p, b) => call(botsUrl + p, b, 'X-Bots-Action');
  const tasks = (p, b) => call(tasksUrl + p, b, 'X-Files-Action');

  const PROMPT = `你是 CEO Agent。主人${ctx.ownerName ? '（' + ctx.ownerName + '）' : ''}正在调度台上对你说话。文字多半是语音识别出来的，可能有同音错字，按意思理解；实在听不明白就问他，不要猜着派活。
你的工作是决定这句话由谁来办。只输出一个 JSON，不要输出别的：
{"action":"reply 或 agent 或 bot","bot":"Bot 的名字，action 是 bot 时才填","followUp":false,"hangup":false,"look":[],"task":"交给对方的任务说明","say":"对主人说的一句话"}

三种做法：
- reply：你自己直接回答。适用于：问现在的运行情况（只用下面给你的监控数据回答，不要编造）、闲聊、问你能做什么、或者你需要先问清楚再派活。这时 say 就是你的回答，最多 200 字，task 留空。
- agent：交给专用 Agent。它是一台有完整开发环境的 Linux 电脑上的 Claude，能写代码、处理文件、查资料、发邮件、发布网页；需要在主人的服务器上执行命令时会另外走审批。适合要分好几步完成的正事、写程序、和主人的服务器或文件有关的事。
- bot：交给某个 Bot。Bot 有一台带浏览器和桌面的电脑，适合上网查东西、打开网页截图、画图出图、轻量的问答和杂事。从下面的 Bot 名单里按名字选一个；名单是空的或者都不合适就用 agent。主人点名要某个 Bot 时照办。

task 怎么写：把主人的要求完整、清楚地转述成一段任务说明，纠正明显的识别错字，补上从上文对话里能确定的指代（"刚才那个""它"）。不要添加主人没有提的要求，不要替他做他没做的决定。
followUp：主人这句话是在接着上一件已经交给专用 Agent 的事往下说（修改、补充、追问）时填 true，这样会在原来那个任务的基础上继续；否则填 false。
action 是 agent 或 bot 时，say 用一句话告诉主人交给了谁、去做什么，不超过 60 字。
主人要求的事明显会造成破坏（删数据、关停线上业务之类）时先不要派出去，用 reply 向他确认一遍。
look：你回答这句话时用到了哪些部门的监控数据，就把它们的代号写进去（可以多个，没用到就留空数组）：site 是网站监控，srv 是服务器，relay 是中转站，music 是音乐机器人。主人会在地图上看到你去那个部门查了一趟。只是闲聊、或者把事情交给别人办时留空。
hangup：只有正在通话时才有用。主人表示这通电话可以结束了（比如"挂了吧""你挂电话吧""先这样""没别的事了""再见""晚安"），就填 true，say 里说一句简短的道别——你说完这句，电话会自动挂断。主人还有事要说、或者只是让你去办一件事，填 false。你自己不要主动提出挂电话。
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
      return { action, bot: String(j.bot || '').trim(), followUp: j.followUp === true, hangup: j.hangup === true, look: (Array.isArray(j.look) ? j.look : []).filter((k) => ['site', 'srv', 'relay', 'music'].includes(k)).slice(0, 4), task: String(j.task || '').trim().slice(0, 6000), say: String(j.say || '').trim().slice(0, 600) };
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
    let hang = false;   // 主人说可以挂电话了：这一句回答说完，页面就把电话挂断
    let look = [];   // 这一句回答查了哪些部门的数据：页面会在地图上画出它去查的那一趟
    const say = (m) => push({ ...m, ...(hang ? { hangup: true } : {}), ...(look.length ? { look } : {}) });
    try {
      const d = await decide(text, inCall);
      hang = Boolean(inCall && d.hangup);
      look = d.action === 'reply' ? d.look || [] : [];
      if (d.action === 'bot') {
        const want = d.bot.toLowerCase();
        const bot = d.botList.find((b) => b.name.toLowerCase() === want) || (want && d.botList.find((b) => b.name.toLowerCase().includes(want)));
        if (!bot) d.action = 'agent';   // 没有这个 Bot：改交给专用 Agent
        else if (bot.running) return say({ role: 'ceo', text: '这件事适合交给「' + bot.name + '」，但它正在忙别的。等它做完再说一遍，或者告诉我换一个人做。' });
        else {
          const before = (await bots('/api/chat?bot=' + bot.id + '&since=0')).messages.reduce((m, x) => Math.max(m, x.id), 0);
          await bots('/api/send', { bot: bot.id, text: '【主人通过 CEO Agent 交代的事】\n' + (d.task || text) });
          note({ verdict: 'dispatch', who: '', what: '主人口头交代的事，交给了 Bot「' + bot.name + '」', reason: (d.task || text).slice(0, 120) });
          return say({ role: 'ceo', text: d.say || '已经交给「' + bot.name + '」。', to: 'Bot「' + bot.name + '」', task: d.task || text, ref: { kind: 'bot', id: bot.id, name: bot.name, before }, state: 'running' });
        }
      }
      if (d.action === 'agent') {
        if (!tasksUrl) return say({ role: 'ceo', text: '专用 Agent 没有接入，这件事派不出去。' });
        const prompt = (d.task || text).slice(0, 7900);
        const prev = d.followUp ? log.slice().reverse().find((m) => m.ref && m.ref.kind === 'agent' && m.state !== 'running') : null;
        let made = null;
        if (prev) made = await tasks('/api/create', { prompt, continueFrom: prev.ref.id }).catch(() => null);   // 接不上就当一件新的事
        const continued = Boolean(made);
        if (!made) made = await tasks('/api/create', { prompt });
        note({ verdict: 'dispatch', who: '', what: '主人口头交代的事，交给了专用 Agent' + (continued ? '（接着上一件继续）' : ''), reason: prompt.slice(0, 120) });
        return say({ role: 'ceo', text: d.say || '已经交给专用 Agent。', to: '专用 Agent', task: prompt, ref: { kind: 'agent', id: made.id }, state: 'running' });
      }
      return say({ role: 'ceo', text: d.say || '我没有想好怎么回答，换个说法再说一遍。' });
    } catch (e) {
      return say({ role: 'ceo', text: '这句话没有处理成：' + String(e.message || e).slice(0, 160), failed: true });
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
      if (req.method === 'GET' && route === '/asr') return json(res, 200, asrView());
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      if (req.headers['x-voice-action'] !== '1') return json(res, 403, { error: '请求来源不对' });
      // 流式识别：页面每 0.2 秒送来一小段正在说的话，回给它到目前为止认出来的字。
      if (route === '/stream/push') {
        if (!asrReady() || asr.stream === false) return json(res, 409, { error: '没有启用流式识别' });
        if (Date.now() < (asrState.streamDownUntil || 0)) return json(res, 409, { error: '流式识别刚才连不上，先用整句识别' });
        const q = new URL(req.url, 'http://x').searchParams, sid = String(q.get('sid') || '').replace(/[^\w-]/g, '').slice(0, 40);
        if (!sid) return json(res, 400, { error: '缺少编号' });
        if (!streams.has(sid) && streams.size >= 6) return json(res, 429, { error: '同时在识别的太多了' });
        return json(res, 200, await pushStream(sid, await readRaw(req, 2 * 1024 * 1024), q.get('last') === '1'));
      }
      if (route === '/stt') {
        const audio = await readRaw(req, 12 * 1024 * 1024);
        if (audio.length < 800) return json(res, 400, { error: '录音是空的' });
        if (asrReady()) {
          try {
            const text = await doubao(audio, 'wav');
            asrState.lastOk = Date.now(); asrState.lastError = '';
            return json(res, 200, { text, engine: 'doubao' });
          } catch (e) {
            asrState.lastError = String(e.message || e).slice(0, 200); asrState.lastErrorAt = Date.now();
            console.log('[语音识别] 豆包这一句没成，退回本机模型：' + asrState.lastError);
          }
        }
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
      // 语音识别的设置：保存密钥和自定义词。密钥栏留空表示不改原来的。
      if (route === '/asr/save') {
        const body = JSON.parse((await readRaw(req, 60000)).toString('utf8') || '{}');
        const str = (v) => String(v || '').trim().slice(0, 300);
        asr.mode = body.mode === 'old' ? 'old' : 'new';
        if (str(body.apiKey)) asr.apiKey = str(body.apiKey);
        if (str(body.appId)) asr.appId = str(body.appId);
        if (str(body.accessToken)) asr.accessToken = str(body.accessToken);
        asr.hotwords = [...new Set(String(body.hotwords || '').split(/[\n,，、]+/).map((w) => w.trim().slice(0, 30)).filter(Boolean))].slice(0, 300);
        asr.enabled = Boolean(body.enabled) && asrHasKey();
        asr.stream = body.stream !== false;
        asrState.streamWords = true; asrState.streamDownUntil = 0;
        saveAsr();
        asrState.lastError = '';
        console.log(`[语音识别] 设置已保存：${asr.enabled ? '用豆包' : '用本机模型'}，自定义词 ${asr.hotwords.length} 个`);
        return json(res, 200, asrView());
      }
      // 试一下：让本机先合成一句话，再交给豆包识别，看能不能认出来。
      if (route === '/asr/test') {
        if (!asrHasKey()) return json(res, 400, { error: '还没有填密钥' });
        try {
          const said = '你好，这是调度台的语音识别测试。';
          const t = await fetch(sttUrl + 'tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: said }), signal: AbortSignal.timeout(30000) });
          if (!t.ok) return json(res, 502, { error: '本机合成不了测试用的语音' });
          const audioBuf = Buffer.from(await t.arrayBuffer()), audioFmt = /mpeg/.test(t.headers.get('content-type') || '') ? 'mp3' : 'wav';
          let text = '';
          try { text = await doubao(audioBuf, audioFmt); } catch (e) { if (asr.stream === false) throw e; text = '（整句识别没通过：' + String(e.message || e).slice(0, 80) + '）'; }
          asrState.lastOk = Date.now(); asrState.lastError = '';
          let stream = null;
          if (asr.stream !== false) {
            asrState.streamDownUntil = 0;
            const sid = 'test-' + crypto.randomUUID(), mp3 = Buffer.from(audioBuf);
            for (let o = 0; o < mp3.length; o += 8000) await pushStream(sid, mp3.subarray(o, o + 8000), false, audioFmt);
            const r = await pushStream(sid, Buffer.alloc(0), true, audioFmt);
            stream = r.error ? { error: r.error } : { text: r.text };
          }
          return json(res, 200, { ok: true, said, text, wordsOk: asrState.wordsOk, stream });
        } catch (e) {
          asrState.lastError = String(e.message || e).slice(0, 200); asrState.lastErrorAt = Date.now();
          return json(res, 502, { error: asrState.lastError });
        }
      }
      // 电话一接通，CEO Agent 先开口：问好，顺带说一句现在的情况。这句话是按当前状态直接拼出来的，不用等模型，所以一接通就能说。
      if (route === '/hello') {
        const body = JSON.parse((await readRaw(req, 2000)).toString('utf8') || '{}');
        const h = Number(body.hour);
        const hi = h >= 5 && h < 11 ? '早上好' : h >= 11 && h < 13 ? '中午好' : h >= 13 && h < 18 ? '下午好' : '晚上好';
        const todo = (state.todo || []).filter((t) => t && t.text);
        const text = hi + (ctx.ownerName ? '，' + ctx.ownerName : '') + '。我是 CEO Agent。'
          + (todo.length ? `现在有 ${todo.length} 件事需要留意，最要紧的是：${String(todo[0].text).replace(/\s+/g, ' ').slice(0, 60)}。` : '现在一切正常，没有告警。')
          + '有什么要交代的？';
        push({ role: 'ceo', text, hello: true });
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
