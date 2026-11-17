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
  let asr = { enabled: false, fast: false, stream: true, tts: true, speaker: 'zh_female_vv_uranus_bigtts', mode: 'new', apiKey: '', appId: '', accessToken: '', hotwords: [] };
  try { asr = { ...asr, ...JSON.parse(fs.readFileSync(ctx.asrFile, 'utf8')) }; } catch (e) { /* 还没设置过 */ }
  const asrState = { lastOk: 0, lastError: '', lastErrorAt: 0, wordsOk: true, streamRes: '', streamWords: true, ttsOk: 0, ttsError: '', ttsDownUntil: 0 };
  const asrHasKey = () => (asr.mode === 'new' ? Boolean(asr.apiKey) : Boolean(asr.appId && asr.accessToken));
  const asrReady = () => Boolean(asr.enabled && ctx.asrFile && asrHasKey());
  const saveAsr = () => { fs.writeFileSync(ctx.asrFile + '.tmp', JSON.stringify(asr), { mode: 0o600 }); fs.renameSync(ctx.asrFile + '.tmp', ctx.asrFile); };
  const tail = (v) => (v ? '…' + String(v).slice(-4) : '');
  const MM_VOICE = 'Chinese (Mandarin)_Crisp_Girl', MM_MODEL = 'speech-2.6-turbo';
  const asrView = () => ({ enabled: asr.enabled, mode: asr.mode, hasKey: asrHasKey(), keyTail: asr.mode === 'new' ? tail(asr.apiKey) : tail(asr.accessToken), appId: asr.mode === 'old' ? asr.appId : '', hotwords: asr.hotwords, stream: asr.stream !== false, tts: asr.tts !== false, speaker: asr.speaker, fast: Boolean(asr.fast), rt: Boolean(asr.rt), mmOn: Boolean(asr.mmOn), mmHasKey: Boolean(asr.mmKey), mmKeyTail: tail(asr.mmKey), mmVoice: asr.mmVoice || MM_VOICE, mmModel: asr.mmModel || MM_MODEL, mmEmotion: asr.mmEmotion || '', mmError: asrState.mmError || '', fastModel: ctx.fastModel || '', mainModel: ctx.mainModel || '', ...asrState });
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
  // ---- 说话的声音：豆包语音合成 2.0 ----
  // 把一句话交给豆包合成，拿回一段 mp3。豆包是一小块一小块往回传的（每块是一段 JSON，里面是 base64 的声音），这里全部收齐再拼起来。
  // MiniMax 的语音合成：把一句话变成 mp3。走美西入口（离这台服务器最近）；密钥只在这里用，不写进日志。
  const mmReady = () => Boolean(asr.mmOn && asr.mmKey && ctx.asrFile && Date.now() >= (asrState.mmDownUntil || 0));
  async function minimaxTts(text) {
    const res = await fetch('https://api-uw.minimax.io/v1/t2a_v2', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + asr.mmKey },
      body: JSON.stringify({
        model: asr.mmModel || MM_MODEL, text, stream: false, language_boost: 'Chinese', output_format: 'hex',
        voice_setting: { voice_id: asr.mmVoice || MM_VOICE, speed: 1, vol: 1, pitch: 0, ...(asr.mmEmotion ? { emotion: asr.mmEmotion } : {}) },
        audio_setting: { sample_rate: 24000, bitrate: 128000, format: 'mp3', channel: 1 },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    const code = j.base_resp ? j.base_resp.status_code : res.status;
    if (!res.ok || code !== 0 || !j.data || !j.data.audio) {
      const why = { 1004: '密钥不对', 2049: '密钥不对', 1008: '账户余额不足', 2053: '账户余额不足', 1002: '请求太频繁', 1039: '请求太频繁', 2054: '没有这个音色', 20132: '没有这个音色', 2042: '这个账号用不了这个音色', 2043: '这个型号不支持这个音色', 2022: '没有这个型号' }[code];
      throw new Error('MiniMax 返回 ' + code + '：' + (why || String((j.base_resp && j.base_resp.status_msg) || '没有返回声音').replace(/\s+/g, ' ').slice(0, 120)));
    }
    return Buffer.from(j.data.audio, 'hex');
  }
  const ttsReady = () => Boolean(asr.enabled && asr.tts !== false && ctx.asrFile && asrHasKey() && Date.now() >= asrState.ttsDownUntil);
  // 把连在一起的一串 JSON 拆开：可能是一行一个，也可能首尾相接没有换行。
  function splitJson(text) {
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth++ === 0) start = i; }
      else if (ch === '}' && --depth === 0 && start >= 0) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch (e) { /* 这一块坏了，跳过 */ } start = -1; }
    }
    return out;
  }
  async function doubaoTts(text) {
    const res = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Resource-Id': 'seed-tts-2.0', 'X-Api-Request-Id': crypto.randomUUID(),
        ...(asr.mode === 'new' ? { 'X-Api-Key': asr.apiKey } : { 'X-Api-App-Id': asr.appId, 'X-Api-Access-Key': asr.accessToken }) },
      body: JSON.stringify({ user: { uid: 'dispatch' }, req_params: { text, speaker: asr.speaker, audio_params: { format: 'mp3', sample_rate: 24000 } } }),
      signal: AbortSignal.timeout(25000),
    });
    const raw = await res.text();
    const parts = [];
    let done = false, bad = '';
    for (const j of splitJson(raw)) {
      if (j.code === 0 || j.code === 20000000) { if (j.data) parts.push(Buffer.from(j.data, 'base64')); if (j.code === 20000000) done = true; }
      else if (j.code !== undefined) bad = `${j.code}：${String(j.message || '').slice(0, 120)}`;
    }
    if (bad || !parts.length) {
      const why = res.status === 401 || res.status === 403 ? '密钥不对，或者没有开通"语音合成模型2.0"' : /speaker permission denied|access denied/i.test(bad) ? '这个音色用不了：它不属于语音合成 2.0，或者你的账号没有这个音色' : bad || `返回 ${res.status}：${raw.replace(/\s+/g, ' ').slice(0, 100)}`;
      throw new Error('豆包合成没成：' + why);
    }
    if (!done) console.log('[语音合成] 豆包没有发来结束标记，按已经收到的声音播放');
    return Buffer.concat(parts);
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
    const s = { ws: null, open: false, pending: [], text: '', definite: false, final: false, error: '', at: Date.now(), born: Date.now(), waiters: [] };
    streams.set(sid, s);
    const wake = () => { for (const w of s.waiters.splice(0)) w(); };
    const fail = (msg, code) => {
      if (s.error || s.final || s.done) return;   // 已经收尾的那条连接再断开，不算出错
      s.error = msg;
      if (code === 45000001 && asrState.streamWords && asr.hotwords.length) asrState.streamWords = false;   // 多半是不收自定义词：下一句不带了
      if (code === 45000081) { try { s.ws.close(); } catch (e) { /* 已经断了 */ } return wake(); }   // 页面那边没再送声音（挂断了，或者只是一声杂音）：不算故障
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
        opened = true; s.open = true; s.res = order[i]; asrState.streamRes = order[i];
        // 自定义词：流式接口只收很少的词，挑排在前面的，总长度控制在 60 个字以内。
        const words = [];
        let len = 0;
        for (const w of asr.hotwords) { if (len + w.length > 60) break; words.push(w); len += w.length; }
        const request = { model_name: 'bigmodel', enable_itn: true, enable_punc: true, show_utterances: true, result_type: 'full', enable_nonstream: true, end_window_size: 700 };
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
    // 豆包认为"一个句子完了"（definite）不等于主人把话说完了：长话里句子之间本来就有停顿。所以这里不结束，交给页面按停顿时间决定。
    if (last || s.error || s.final) {
      if (!s.error) { asrState.lastOk = Date.now(); asrState.lastError = ''; }
      if (!String(sid).startsWith('test-')) console.log(`[语音识别] 流式一句：${s.res === 'volc.seedasr.sauc.duration' ? '豆包流式识别 2.0' : s.res === 'volc.bigasr.sauc.duration' ? '豆包流式识别 1.0' : '没连上'}，${s.error ? '出错' : s.definite && !last ? '豆包判断说完' : '本地等够后收尾'}，认出 ${s.text.length} 个字，用时 ${((Date.now() - s.born) / 1000).toFixed(1)} 秒`);
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

  // CEO Agent 说话的性格（主人定的默认性格）。只管"怎么说"，不管"怎么做"：派活、叫停、报数据照样一丝不苟。
  // 想换一种性格：在 config.json 里写 ceoPersona（一段话）就会代替下面这段。
  const PERSONA = ctx.persona || '你说话的性格：反骨仔。嘴上不服管、爱抬杠、爱吐槽，会损主人两句，偶尔爆句粗口（比如"靠""我去""他妈的"），像一个嘴欠但跟了主人很多年的老搭档。这股劲儿要自然、随机，不是每句话都带：大约三句里有一两句就是正常说话，干脆利落地答完、办完，一个情绪词都没有；想损的时候才损一句。不要养成口头禅——不要总用同一个开头（比如每句都"行行行""靠""我去"），看一眼"最近的对话"里你自己前几句是怎么开头、怎么吐槽的，这一句换个说法，或者干脆不带情绪。吐槽要针对眼前这件具体的事，不要套话；粗口更少，偶尔才来一次。但你做事非常靠谱：嘴上再怎么抱怨，该办的事一件不落、马上去办；数据、结论、交给谁办这些一个字都不乱说，不夸大也不编造；听不清就直说没听清。粗口是语气，不是攻击：不拿主人的家人、长相、身体开玩笑，不说歧视人的话。主人在说正经的急事（出故障、有告警）时少贫嘴，先说要紧的。这个性格只体现在 say 里；task 是交给下属的任务说明，照常写得清楚、正经，不带脏话。';
  const PROMPT = `你是 CEO Agent。主人${ctx.ownerName ? '（' + ctx.ownerName + '）' : ''}正在调度台上对你说话。文字多半是语音识别出来的，可能有同音错字，按意思理解；实在听不明白就问他，不要猜着派活。
你的工作是决定这句话由谁来办。只输出一个 JSON，不要输出别的：
{"action":"reply 或 agent 或 bot 或 stop","bot":"Bot 的名字，action 是 bot 时才填（action 是 stop 时：要叫停的是 Bot 就填它的名字，是专用 Agent 就留空）","say":"对主人说的一句话","revise":false,"followUp":false,"hangup":false,"look":[],"task":"交给对方的任务说明"}
各项就按上面这个顺序写（先想好再动笔：action 定下来之后紧接着写 say，因为 say 会在你写完其余各项之前就先念给主人听）。

三种做法：
- reply：你自己直接回答。适用于：问现在的运行情况（只用下面给你的监控数据回答，不要编造）、闲聊、问你能做什么、或者你需要先问清楚再派活。这时 say 就是你的回答，最多 200 字，task 留空。
- agent：交给专用 Agent。它是一台有完整开发环境的 Linux 电脑上的 Claude，能写代码、处理文件、查资料、发邮件、发布网页；需要在主人的服务器上执行命令时会另外走审批。适合要分好几步完成的正事、写程序、和主人的服务器或文件有关的事。
- bot：交给某个 Bot。Bot 有一台带浏览器和桌面的电脑，适合上网查东西、打开网页截图、画图出图、轻量的问答和杂事。从下面的 Bot 名单里按名字选一个；名单是空的或者都不合适就用 agent。主人点名要某个 Bot 时照办。

- stop：主人要叫停、暂停、取消一件正在办的事（看下面给你的"正在办的事"）。这时不派新活，只让对方停下来；say 用一句话告诉主人已经叫停了谁。主人说的"暂停"也按叫停处理（停下来之后不能从中间接着做，要重新交代）。"正在办的事"是空的就用 reply 告诉他现在没有在办的事。
revise：只在 action 是 bot 时有用。那个 Bot 正在忙，而且忙的正是主人刚才交给它的那件事，主人现在是在修改或补充这件事的要求（比如"找一个二十岁左右的""换成另一个网站"），就填 true：会让它先停下手上的，再按新的要求重新做。这时 task 必须写成修改之后的完整任务（原来的要求加上这次的修改），不能只写修改的那一句。主人交代的是另一件不相干的事，填 false。

task 怎么写：只转述，不加料。把主人说的要求原样、完整地写成一段任务说明，尽量用他自己的话；只做三件事：纠正明显的识别错字，补上从上文对话里能确定的指代（"刚才那个""它"），修改要求时把原来的要求和这次的修改合成一段。
task 里严禁出现主人没有说过的东西，包括但不限于：他没要求的步骤和做法、他没要求的交付物（比如"交回链接""截一张图""写一份介绍""发布成网页""列出清单"）、他没提的条件和限制、你觉得"顺便做了更好"的事、遇到某种情况该怎么办的预案。主人说"找一个跳舞的女主播"，task 就只是"找一个跳舞的女主播"加上必要的上下文，不要替他规定要交回什么。对方怎么做、交回什么由对方自己判断。主人的要求太含糊、不补充就没法做时，用 reply 问他，不要自己替他补全。写完 task 自查一遍：每一句要求都能在主人说过的话里找到出处，找不到的删掉。
转交要严谨。不加料不等于写得含糊：task 是对方唯一能看到的交代，必须让它不可能办错。具体做到：
1. 对象写准：是哪个平台、哪个账号、哪个人、哪个直播间，用上文里已经确定的确切名字，不用"那个""刚才的"。
2. 动作写准：主人说的动作有容易混淆的近似做法时，点明是哪一个、不是哪一个（比如"送礼物栏里名叫小心心的礼物，不是点赞，也不是名字相近的别的礼物"）。数量、名称照主人说的写，主人没说数量就写"一个"之类他原话里的量，不要自己定。
3. 拿不准就停：在 task 末尾固定加一句"找不到完全对得上的、或者拿不准主人指的是哪一个时，先停下来说明情况，不要挑一个相近的顶替"。这一句是为了不办错，不算加料。
4. 要花钱、要发出去收不回、要删除或修改东西的事，更要严：名称、对象、数量有任何一项你自己都不确定（包括可能是语音识别听错的同音字），就不要派出去，用 reply 先跟主人核对清楚再派。
5. 语气：task 一律正经、平实、完整的句子，不带玩笑、吐槽和口头语；say 里告诉主人交给了谁、去做什么这部分也要说准，玩笑不能盖过或者歪曲交代的内容。
followUp：主人这句话是在接着上一件已经交给专用 Agent 的事往下说（修改、补充、追问）时填 true，这样会在原来那个任务的基础上继续；否则填 false。
action 是 agent 或 bot 时，say 用一句话告诉主人交给了谁、去做什么，不超过 60 字。
主人要求的事明显会造成破坏（删数据、关停线上业务之类）时先不要派出去，用 reply 向他确认一遍。
look：你回答这句话时用到了哪些部门的监控数据，就把它们的代号写进去（可以多个，没用到就留空数组）：site 是网站监控，srv 是服务器，relay 是中转站，music 是音乐机器人。主人会在地图上看到你去那个部门查了一趟。只是闲聊、或者把事情交给别人办时留空。
hangup：只有正在通话时才有用。主人表示这通电话可以结束了（比如"挂了吧""你挂电话吧""先这样""没别的事了""再见""晚安"），就填 true，say 里说一句简短的道别——你说完这句，电话会自动挂断。主人还有事要说、或者只是让你去办一件事，填 false。你自己不要主动提出挂电话。
不要用 Markdown。
${PERSONA}
如果给你的数据里"正在通话"是 true：主人正在和你打语音电话，say 会被直接念给他听。这时 say 要像打电话一样口语化、简短（一般不超过 50 字），不要出现网址、代码、符号和列表，数字和英文名照常说。`;
  const SPEAK_PROMPT = PERSONA.replace('这个性格只体现在 say 里；task 是交给下属的任务说明，照常写得清楚、正经，不带脏话。', '') + '\n你是 CEO Agent，正在和主人打语音电话。下属把一件事的结果交回来了，你要把结果口头转告主人。只输出要说的话本身：口语化，不超过 80 字，先说谁做完了（或没做成），再说最要紧的结论；不要念网址、代码、符号和列表，有文件或链接就说"详细的在通话记录里"。';
  // 念之前把网址和排版符号去掉。
  const forSpeech = (s) => String(s || '').replace(/https?:[^ \n）)]+/g, '链接').replace(/[*_#`>|~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
  async function summarize(it) {
    let speak = '';
    try { speak = forSpeech((await ceoCall(SPEAK_PROMPT, JSON.stringify({ 谁: it.from, 做成了: it.ok, 结果: clip(it.text, 3000) }), 300)).text).slice(0, 240); } catch (e) { /* 说不出来就用下面那句 */ }
    it.speak = speak || (it.from + (it.ok ? '做完了' : '没有做成') + '，详细的在通话记录里。');
    save();
    for (const r of rts.values()) rtSay(r, it.speak);   // 端到端通话正开着：直接念给主人听
  }

  function parse(text) {
    try {
      const j = JSON.parse(String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1));
      const action = ['reply', 'agent', 'bot', 'stop'].includes(j.action) ? j.action : null;
      if (!action) return null;
      return { action, revise: j.revise === true, bot: String(j.bot || '').trim(), followUp: j.followUp === true, hangup: j.hangup === true, look: (Array.isArray(j.look) ? j.look : []).filter((k) => ['site', 'srv', 'relay', 'music'].includes(k)).slice(0, 4), task: String(j.task || '').trim().slice(0, 6000), say: String(j.say || '').trim().slice(0, 600) };
    } catch (e) { return null; }
  }

  // 回答还没写完时，把其中已经写出来的那部分 say 取出来（JSON 还不完整，不能直接解析）。
  function partialSay(buf) {
    const m = /"say"\s*:\s*"/.exec(buf);
    if (!m) return '';
    let out = '';
    for (let i = m.index + m[0].length; i < buf.length; i++) {
      const c = buf[i];
      if (c === '"') break;
      if (c !== '\\') { out += c; continue; }
      if (i + 1 >= buf.length) break;
      const n = buf[++i];
      if (n === 'u') { if (i + 4 >= buf.length) break; out += String.fromCharCode(parseInt(buf.slice(i + 1, i + 5), 16) || 32); i += 4; }
      else out += n === 'n' || n === 't' || n === 'r' ? ' ' : n;
    }
    return out.trimStart();
  }

  async function decide(text, inCall, onSay) {
    let botList = [], botErr = '';
    try { botList = (await bots('/api/state')).bots || []; } catch (e) { botErr = 'Bot 那边现在连不上'; }
    const input = {
      主人说: text,
      正在通话: Boolean(inCall),
      最近的对话: log.slice(-9, -1).map((m) => ({ 谁: m.role === 'me' ? '主人' : m.role === 'result' ? m.from + '的结果' : 'CEO Agent' + (m.to ? '（交给了' + m.to + '）' : ''), 内容: clip(m.task || m.text, 400) })),
      Bot名单: botList.map((b) => ({ 名字: b.name, 设定: String(b.persona || '').slice(0, 120), 正在忙: Boolean(b.running) })),
      Bot情况: botErr || undefined,
      正在办的事: log.filter((m) => m.state === 'running' && m.ref).map((m) => ({ 交给了: m.to, 任务: clip(m.task, 300) })),
      监控数据: ctx.briefInput ? ctx.briefInput() : undefined,
      当前简报: state.brief && state.brief.text ? state.brief.text : undefined,
    };
    // 打电话时可以让更快的模型来接话（在"识别设置"里开）：它只负责听懂、回答、决定交给谁；审批和简报仍然是 CEO 的主模型。快的那个没答上来就换回主模型。
    const t0 = Date.now(), useFast = Boolean(inCall && asr.fast && ctx.fastCall);
    let r = null;
    if (useFast) { try { r = await ctx.fastCall(PROMPT, JSON.stringify(input), 900); if (!parse(r.text)) r = null; } catch (e) { r = null; } }
    const usedFast = Boolean(r);
    // 打电话时让 CEO 的主模型边想边出字：say 的第一句一写出来就交给页面去念，不用等整段写完。
    // 只在它自己回答、或者交给专用 Agent 时这样做；交给 Bot 要先确认那个 Bot 在不在、忙不忙，等想完再说。
    let streamed = '', firstAt = 0, wasWarm = false;
    if (!r && inCall && ctx.ceoStream) {
      try {
        r = await ctx.ceoStream(PROMPT, JSON.stringify(input), (buf) => {
          const a = /"action"\s*:\s*"(\w+)"/.exec(buf);
          if (!a || (a[1] !== 'reply' && a[1] !== 'agent' && a[1] !== 'bot')) return;
          if (a[1] === 'bot') {
            // 交给 Bot：名字写在 say 前面。这个 Bot 确实有、而且现在空闲，才提前念；它正忙着（要先叫停或者要回绝）就等想完再说。
            const n = /"bot"\s*:\s*"([^"]*)"/.exec(buf), want = n ? n[1].trim().toLowerCase() : '';
            const hit = want && (botList.find((b) => b.name.toLowerCase() === want) || botList.find((b) => b.name.toLowerCase().includes(want)));
            if (!hit || hit.running) return;
          }
          const p = partialSay(buf);
          if (!p.trim() || p === streamed) return;
          if (!firstAt) firstAt = Date.now();
          streamed = p;
          if (onSay) onSay(p);
        });
        wasWarm = Boolean(r.warm);
      } catch (e) {
        console.log('[通话] 边想边说这一次没成（' + String(e.message || e).slice(0, 100) + '）' + (streamed ? '，已经说出口的部分照用' : '，改成想完再说'));
        if (streamed) return { action: 'reply', say: streamed, botList };
        r = null;
      }
    }
    const usedStream = Boolean(r) && !usedFast;
    if (!r) r = await ceoCall(PROMPT, JSON.stringify(input), 900);
    if (inCall) console.log(`[通话] ${usedFast ? '快速模型 ' + (ctx.fastModel || '') : 'CEO 主模型'}想了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒${usedStream ? `（边想边说，${firstAt ? '第 ' + ((firstAt - t0) / 1000).toFixed(1) + ' 秒开始有话可念' : '没有提前念'}，${wasWarm ? '用的是待命的' : '临时启动的'}）` : ''}${useFast && !usedFast ? '（快速模型没答上来，换回了主模型）' : ''}`);
    const out = parse(r.text);
    if (!out) return { action: 'reply', say: streamed || r.text.replace(/\s+/g, ' ').slice(0, 400), botList };
    return { ...out, botList };
  }

  async function handleSay(text, inCall, opts) {
    opts = opts || {};
    busy = true;
    let hang = false;   // 主人说可以挂电话了：这一句回答说完，页面就把电话挂断
    let look = [];   // 这一句回答查了哪些部门的数据：页面会在地图上画出它去查的那一趟
    // 边想边说：回答还在写的时候，先放一条"正在写"的记录进去，字越来越多；页面看到完整的一句就先念。
    let live = null;
    const onSay = (t) => { if (!live) { live = { id: ++seq, at: Date.now(), role: 'ceo', text: t, streaming: true }; log.push(live); } else live.text = t; };
    const say = (m) => {
      const extra = { ...(hang ? { hangup: true } : {}), ...(look.length ? { look } : {}) };
      if (live) {
        const it = live;
        live = null; delete it.streaming;
        // 最后定下来的话就是刚才边写边念的那一段：把这条记录补全。不一样（比如事情没派出去）：已经念出口的留着，另起一条说明。
        if (String(m.text || '').startsWith(it.text.trim())) { Object.assign(it, m, extra); save(); return it; }
      }
      return push({ ...m, ...extra });
    };
    try {
      const d = await decide(text, inCall, opts.rt ? null : onSay);
      opts.action = d.action;
      hang = Boolean(inCall && d.hangup);
      look = d.action === 'reply' ? d.look || [] : [];
      const findBot = (name) => { const want = String(name || '').toLowerCase(); return d.botList.find((b) => b.name.toLowerCase() === want) || (want && d.botList.find((b) => b.name.toLowerCase().includes(want))) || null; };
      // 叫停一个 Bot：让它停手，等它真的停下来；之前交给它、还挂着"正在做"的记录标成"已叫停"，免得稍后把半截结果当成做完了念出来。
      const stopBot = async (bot) => {
        await bots('/api/stop', { bot: bot.id });
        for (const m of log) if (m.state === 'running' && m.ref && m.ref.kind === 'bot' && m.ref.id === bot.id) m.state = 'stopped';
        save();
        for (let i = 0; i < 20; i++) {
          const now = ((await bots('/api/state')).bots || []).find((b) => b.id === bot.id);
          if (!now || !now.running) return true;
          await new Promise((r) => setTimeout(r, 400));
        }
        return false;
      };
      if (d.action === 'stop') {
        const bot = d.bot ? findBot(d.bot) : null;
        if (bot) {
          if (!bot.running) return say({ role: 'ceo', text: '「' + bot.name + '」现在没有在做事，不用叫停。' });
          const ok = await stopBot(bot);
          note({ verdict: 'dispatch', who: '', what: '主人口头叫停了 Bot「' + bot.name + '」正在做的事', reason: text.slice(0, 120) });
          return say({ role: 'ceo', text: ok ? (d.say || '已经让「' + bot.name + '」停下来了。') : '已经叫「' + bot.name + '」停手，它还没完全停下来，稍等一下。' });
        }
        const job = log.slice().reverse().find((m) => m.state === 'running' && m.ref && m.ref.kind === 'agent');
        if (!job || !tasksUrl) return say({ role: 'ceo', text: d.bot ? '没有找到叫「' + d.bot + '」的 Bot。' : '现在没有正在办的事，不用叫停。' });
        await tasks('/api/stop?id=' + encodeURIComponent(job.ref.id), {});
        job.state = 'stopped'; save();
        note({ verdict: 'dispatch', who: '', what: '主人口头叫停了专用 Agent 正在做的事', reason: text.slice(0, 120) });
        return say({ role: 'ceo', text: d.say || '已经让专用 Agent 停下来了。' });
      }
      if (d.action === 'bot') {
        const bot = findBot(d.bot);
        if (!bot) d.action = 'agent';   // 没有这个 Bot：改交给专用 Agent
        else if (bot.running && !d.revise) return say({ role: 'ceo', text: '「' + bot.name + '」正在忙别的事。要它先停下来改做这件，就跟我说“让它停下来”；或者等它做完再说，也可以换一个人做。' });
        else {
          if (bot.running && !(await stopBot(bot))) return say({ role: 'ceo', text: '我叫「' + bot.name + '」先停手，它还没停下来。稍等一下再说一遍。' });
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
      return say({ role: 'ceo', text: (opts.replyText && opts.replyText()) || d.say || '我没有想好怎么回答，换个说法再说一遍。' });
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

  // ---- 端到端通话（试用，在"识别设置"里开）----
  // 豆包的"端到端实时语音"模型直接听主人的声音、直接出声音，接话很快（不到一秒），打断也自然。
  // 但它自己不会派活，所以分工是这样的：
  //   · 闲聊、问现状：它自己答（现状写在给它的设定里，只是接通那一刻的情况）。
  //   · 主人要办事、叫停、修改、挂电话：它只说一句固定的"收到，我安排一下。"；
  //     同时每句话的文字都照常交给 CEO 的主模型（和普通通话走同一套决定、派活、叫停的逻辑），主模型定下来之后，
  //     把要说的话交回给它念出来。也就是说：嘴和耳朵是豆包的，办事的脑子还是主模型。
  // 页面和这里之间：上行每 0.1 秒送一小段麦克风的声音（rt/up），下行是一条一直开着的回应（rt/down），里面一帧一帧地放声音和事件。
  const rts = new Map();
  const RT_ACK = '收到，我安排一下。';
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  // 发给豆包的一帧：事件号 + 会话号 + 内容。内容是文字（JSON）或者一段原始声音。
  const rtFrame = (event, sid, payload) => {
    const raw = Buffer.isBuffer(payload), p = raw ? payload : Buffer.from(JSON.stringify(payload)), s = sid ? Buffer.from(sid) : null;
    return Buffer.concat([Buffer.from([0x11, raw ? 0x24 : 0x14, raw ? 0x00 : 0x10, 0x00]), u32(event), ...(s ? [u32(s.length), s] : []), u32(p.length), p]);
  };
  function rtParse(buf) {
    const type = buf[1] >> 4, flags = buf[1] & 15, isJson = (buf[2] >> 4) === 1, out = { type, event: 0 };
    let o = 4;
    if (type === 15) { out.code = buf.readUInt32BE(o); o += 4; }
    if (flags & 4) { out.event = buf.readUInt32BE(o); o += 4; }
    if (type !== 15 && out.event >= 100) { o += 4 + buf.readUInt32BE(o); }   // 会话级的事件：后面跟着会话号
    else if (type !== 15 && out.event >= 50) { const n = buf.readUInt32BE(o); if (n > 0 && n < 200 && o + 8 + n <= buf.length) o += 4 + n; }   // 连接级的事件：可能跟着连接号
    const n = buf.readUInt32BE(o), p = buf.subarray(o + 4, o + 4 + n);
    if (isJson || type === 15) { try { out.json = JSON.parse(p.toString('utf8') || '{}'); } catch (e) { out.json = { error: p.toString('utf8').slice(0, 200) }; } } else out.audio = p;
    return out;
  }
  // 给页面的一帧：1 字节类型（1 声音，2 事件，0 保持连接）+ 4 字节长度 + 内容。页面还没来取的时候先攒着。
  function rtDown(s, type, payload) {
    const p = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload || {})), f = Buffer.concat([Buffer.from([type]), u32(p.length), p]);
    if (s.down) { try { s.down.write(f); } catch (e) { /* 页面已经断开 */ } } else if (s.queue.length < 400) s.queue.push(f);
  }
  const rtSend = (s, f) => { try { if (s.ws && s.ws.readyState === 1) s.ws.send(f); } catch (e) { /* 连接已经断了 */ } };
  // 让它把一段现成的话念出来（主模型定下来的话、下属交回来的结果）。
  function rtSay(s, text) {
    text = forSpeech(text);
    if (!text || s.closed || !s.ready) return;
    rtSend(s, rtFrame(500, s.sid, { start: true, content: text, end: false }));
    rtSend(s, rtFrame(500, s.sid, { start: false, content: '', end: true }));
    rtDown(s, 2, { t: 'say', text });
  }
  function rtClose(s, why) {
    if (s.closed) return;
    s.closed = true; rts.delete(s.sid); clearInterval(s.timer);
    rtSend(s, rtFrame(102, s.sid, {}));
    setTimeout(() => { try { s.ws.close(); } catch (e) { /* 已经关了 */ } }, 300);
    if (why) rtDown(s, 2, { t: 'end', why });
    try { if (s.down) s.down.end(); } catch (e) { /* 已经断开 */ }
    console.log(`[端到端通话] 结束（${why || '主人挂断'}），一共 ${s.turns.length} 句，通话 ${Math.round((Date.now() - s.born) / 1000)} 秒`);
  }
  // 主人说完了一句：文字照常交给 CEO 的主模型去决定、去办；它那边定下来之后，看要不要把话交回来念。
  async function rtDecide(s, turn) {
    const deferred = () => !turn.reply.trim() || turn.reply.includes('安排一下');   // 豆包没自己答（说的是那句固定的话，或者什么都没说）
    const opts = { rt: true, replyText: () => (deferred() ? '' : turn.reply.trim()) };
    const t0 = Date.now();
    const it = await handleSay(turn.text, true, opts);
    if (s.closed || !it) return;
    const speak = deferred() || opts.action !== 'reply' || it.failed;
    console.log(`[端到端通话] 「${turn.text.slice(0, 30)}」→ 豆包${deferred() ? '交给后台' : '自己答了'}，主模型的决定是 ${opts.action || '没定下来'}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）${speak ? '，把主模型的话交回去念' : ''}`);
    if (speak) rtSay(s, it.text);
    if (it.hangup) { s.hang = true; setTimeout(() => { if (!s.closed && s.hang && !s.ttsOn) rtDown(s, 2, { t: 'hangup' }); }, 4000); }   // 说完道别的话就挂；它早就说完了的话，等四秒直接挂
  }
  function rtOpen(hour) {
    if (!asrHasKey()) throw new Error('还没有填豆包的密钥');
    for (const old of [...rts.values()]) rtClose(old, '开了新的通话');
    const s = { sid: crypto.randomUUID(), ws: null, down: null, queue: [], turns: [], cur: null, heard: '', chain: Promise.resolve(), ttsOn: false, hang: false, at: Date.now(), born: Date.now(), closed: false, ready: false, timer: null, waiters: [] };
    rts.set(s.sid, s);
    const todo = (state.todo || []).filter((t) => t && t.text).map((t) => String(t.text).replace(/\s+/g, ' ').slice(0, 80)).slice(0, 6);
    const plain = (t) => String(t || '').replace(/[\\"`]/g, '').replace(/\s+/g, ' ');   // 设定里不能有反斜杠、引号这类符号，豆包那边会解析出错
    const role = plain('你是调度台的 CEO Agent，正在和主人' + (ctx.ownerName || '') + '打语音电话。你自己只做两件事：闲聊；以及根据下面的当前情况回答运行状况，只用这里写的内容，这里没有的就说你手上没有这项数据，绝对不要编造数字。'
      + '凡是主人要你去办事、派人、让某个 Bot 或 Agent 做什么、查资料、打开什么、发送什么、买什么送什么、叫停或暂停什么、修改刚才交代的事、问某件交代的事办得怎么样，或者表示要挂电话、说再见：这些你自己都办不了，由后台的调度来办。'
      + '遇到这些情况你只说这一句固定的话，一个字都不要多：' + RT_ACK + ' 不要假装已经办了，不要追问细节，不要复述他的要求。'
      + '当前情况（电话接通时的）：' + (state.brief && state.brief.text ? state.brief.text : '暂时没有简报。') + (todo.length ? ' 需要留意的事：' + todo.join('；') + '。' : ' 现在没有告警。')).slice(0, 3400);
    const style = plain('嘴欠、爱抬杠爱吐槽的老搭档，但不是每句都损人，多数时候就是干脆利落地正常说话；口语化，简短，一般不超过五十个字；不念网址、代码和符号。');
    const auth = asr.mode === 'new' ? { 'X-Api-Key': asr.apiKey } : { 'X-Api-App-ID': asr.appId, 'X-Api-Access-Key': asr.accessToken };
    const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/realtime/dialogue', { headers: { ...auth, 'X-Api-Resource-Id': 'volc.speech.dialog', 'X-Api-App-Key': 'PlgvMymc7f3tQnJ6', 'X-Api-Connect-Id': crypto.randomUUID() } });
    ws.binaryType = 'arraybuffer';
    s.ws = ws;
    const fail = (msg) => { s.error = msg; for (const w of s.waiters.splice(0)) w(); if (!s.closed) { console.log('[端到端通话] ' + msg); rtClose(s, msg); } };
    ws.onopen = () => rtSend(s, rtFrame(1, null, {}));
    ws.onerror = () => fail('和豆包的连接没建立起来（可能没有开通“端到端实时语音大模型”）');
    ws.onclose = () => fail('和豆包的连接断了');
    ws.onmessage = (m) => {
      let f;
      try { f = rtParse(Buffer.from(m.data)); } catch (e) { return; }
      if (f.type === 15) return fail('豆包报错 ' + f.code + '：' + JSON.stringify(f.json || {}).slice(0, 160));
      const j = f.json || {};
      if (f.event === 50) return rtSend(s, rtFrame(100, s.sid, {
        asr: { extra: { end_smooth_window_ms: 1500 } },
        tts: { speaker: 'zh_female_vv_jupiter_bigtts', audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 }, extra: {} },
        dialog: { bot_name: 'CEO Agent', system_role: role, speaking_style: style, extra: { model: ['1', '2', '1', '1'].join('.'), input_mod: 'keep_alive' } },
      }));
      if (f.event === 51 || f.event === 153) return fail('豆包没有开成这通电话：' + String(j.error || '').slice(0, 160));
      if (f.event === 599) { console.log('[端到端通话] 豆包提示 ' + JSON.stringify(j).slice(0, 200)); return; }
      if (f.event === 150) {   // 会话开好了：让它先开口问好
        s.ready = true;
        const hello = helloText(hour);
        push({ role: 'ceo', text: hello, hello: true });
        rtSend(s, rtFrame(300, s.sid, { content: forSpeech(hello) }));
        rtDown(s, 2, { t: 'say', text: hello });
        if (ctx.ceoWarm) ctx.ceoWarm(PROMPT);
        for (const w of s.waiters.splice(0)) w();
        return;
      }
      if (f.event === 450) { s.heard = ''; s.hang = false; rtDown(s, 2, { t: 'interrupt' }); if (ctx.ceoWarm) ctx.ceoWarm(PROMPT); return; }   // 主人开口了：页面马上停掉正在播的声音
      if (f.event === 451) { const r = (j.results || [])[0]; if (r && r.text) { s.heard = r.text; rtDown(s, 2, { t: 'asr', text: r.text }); } return; }
      if (f.event === 459) {   // 主人这一句说完了
        const text = String(s.heard || '').trim();
        s.heard = '';
        if (!text) return;
        const turn = { text, reply: '' };
        s.turns.push(turn); s.cur = turn;
        push({ role: 'me', text });
        rtDown(s, 2, { t: 'heard', text });
        s.chain = s.chain.then(() => rtDecide(s, turn)).catch((e) => console.log('[端到端通话] 这一句没处理成：' + String(e.message || e).slice(0, 120)));
        return;
      }
      if (f.event === 550) { if (s.cur && j.content) s.cur.reply += j.content; return; }
      if (f.event === 350) { s.ttsOn = true; if (j.text && j.tts_type !== 'chat_tts_text') rtDown(s, 2, { t: 'say', text: j.text }); return; }
      if (f.event === 352 && f.audio) { s.ttsOn = true; return rtDown(s, 1, f.audio); }
      if (f.event === 359) { s.ttsOn = false; rtDown(s, 2, { t: 'ttsend' }); if (s.hang) { s.hang = false; rtDown(s, 2, { t: 'hangup' }); } }
    };
    // 页面半分钟没送声音来（关了网页、断网）：收掉这通电话。每十几秒往下行里放一个空帧，免得中间的代理以为连接死了。
    s.timer = setInterval(() => { if (Date.now() - s.at > 30000) rtClose(s, '页面那边没有声音送来了'); else rtDown(s, 0, Buffer.alloc(0)); }, 12000);
    return s;
  }

  // 电话接通时的开场白：按当前状态直接拼出来，不用等模型。
  function helloText(h) {
    const hi = h >= 5 && h < 11 ? '早上好' : h >= 11 && h < 13 ? '中午好' : h >= 13 && h < 18 ? '下午好' : '晚上好';
    const todo = (state.todo || []).filter((t) => t && t.text);
    const text = ctx.persona ? hi + (ctx.ownerName ? '，' + ctx.ownerName : '') + '。我是 CEO Agent。'
      + (todo.length ? `现在有 ${todo.length} 件事需要留意，最要紧的是：${String(todo[0].text).replace(/\s+/g, ' ').slice(0, 60)}。` : '现在一切正常，没有告警。') + '有什么要交代的？'
      // 默认性格（反骨仔）的开场白：嘴欠，但该报的情况照报。
      : '哟，' + (ctx.ownerName ? ctx.ownerName + '，' : '') + (h >= 0 && h < 5 ? '大半夜的还不睡。' : h < 11 ? '这么早就来了。' : h < 18 ? '又是你。' : '大晚上的又来了。')
      + (todo.length ? `先说正事，现在有 ${todo.length} 件事要留意，最要紧的是：${String(todo[0].text).replace(/\s+/g, ' ').slice(0, 60)}。` : '放心，现在一切正常，没出什么幺蛾子。') + '说吧，这回又要我干嘛？';
    return text;
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
      // 端到端通话的下行：一条一直开着的回应，声音和事件一帧一帧往里放。页面断开就收掉这通电话。
      if (req.method === 'GET' && route === '/rt/down') {
        const r = rts.get(String(new URL(req.url, 'http://x').searchParams.get('sid') || ''));
        if (!r) return json(res, 410, { error: '这通电话已经结束了' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        r.down = res;
        for (const f of r.queue.splice(0)) res.write(f);
        req.on('close', () => rtClose(r, ''));
        return;
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      if (req.headers['x-voice-action'] !== '1') return json(res, 403, { error: '请求来源不对' });
      // 流式识别：页面每 0.2 秒送来一小段正在说的话，回给它到目前为止认出来的字。
      if (route === '/stream/push') {
        if (!asrReady() || asr.stream === false) return json(res, 409, { error: '没有启用流式识别' });
        if (Date.now() < (asrState.streamDownUntil || 0)) return json(res, 409, { error: '流式识别刚才连不上，先用整句识别' });
        const q = new URL(req.url, 'http://x').searchParams, sid = String(q.get('sid') || '').replace(/[^\w-]/g, '').slice(0, 40);
        if (!sid) return json(res, 400, { error: '缺少编号' });
        if (!streams.has(sid) && streams.size >= 6) return json(res, 429, { error: '同时在识别的太多了' });
        if (!streams.has(sid) && ctx.ceoWarm) ctx.ceoWarm(PROMPT);   // 主人刚开口：趁他说话，让 CEO 的模型先准备好
        return json(res, 200, await pushStream(sid, await readRaw(req, 2 * 1024 * 1024), q.get('last') === '1'));
      }
      if (route === '/rt/start') {
        const body = JSON.parse((await readRaw(req, 2000)).toString('utf8') || '{}');
        const r = rtOpen(Number(body.hour));
        await new Promise((ok) => { r.waiters.push(ok); setTimeout(ok, 9000); });
        if (!r.ready) { const why = r.error || '豆包那边没有回应'; rtClose(r, why); return json(res, 502, { error: why }); }
        console.log('[端到端通话] 接通');
        return json(res, 200, { sid: r.sid });
      }
      if (route === '/rt/up' || route === '/rt/stop') {
        const r = rts.get(String(new URL(req.url, 'http://x').searchParams.get('sid') || ''));
        if (route === '/rt/stop') { await readRaw(req, 2000); if (r) rtClose(r, ''); return json(res, 200, { ok: true }); }
        const pcm = await readRaw(req, 1024 * 1024);
        if (!r) return json(res, 410, { error: '这通电话已经结束了' });
        r.at = Date.now();
        for (let o = 0; o + 1 < pcm.length; o += 640) rtSend(r, rtFrame(200, r.sid, pcm.subarray(o, Math.min(pcm.length, o + 640))));   // 豆包建议每 20 毫秒一包
        return json(res, 200, { ok: true });
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
        asr.tts = body.tts !== false;
        asr.fast = Boolean(body.fast);
        asr.rt = Boolean(body.rt);
        // MiniMax 语音合成：密钥栏留空表示不改原来的；没有密钥就开不了
        if (str(body.mmKey)) asr.mmKey = String(body.mmKey).trim().slice(0, 2000);
        if (/^[\w .()\-]{2,80}$/.test(String(body.mmVoice || '').trim())) asr.mmVoice = String(body.mmVoice).trim();
        if (['speech-2.6-turbo', 'speech-2.6-hd', 'speech-2.8-turbo', 'speech-2.8-hd'].includes(body.mmModel)) asr.mmModel = body.mmModel;
        asr.mmEmotion = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent'].includes(body.mmEmotion) ? body.mmEmotion : '';
        asr.mmOn = Boolean(body.mmOn) && Boolean(asr.mmKey);
        asrState.mmError = ''; asrState.mmDownUntil = 0;
        if (/^[\w-]{3,80}$/.test(String(body.speaker || '').trim())) asr.speaker = String(body.speaker).trim();
        asrState.ttsError = ''; asrState.ttsDownUntil = 0;
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
        const text = helloText(Number(body.hour));
        push({ role: 'ceo', text, hello: true });
        if (ctx.ceoWarm) ctx.ceoWarm(PROMPT);   // 电话接通：让 CEO 的模型先开好等着
        return json(res, 200, { ok: true });
      }
      if (route === '/tts') {
        const body = JSON.parse((await readRaw(req, 20000)).toString('utf8') || '{}');
        const text = forSpeech(body.text);
        if (!text) return json(res, 400, { error: '没有要念的内容' });
        if (mmReady()) {
          try {
            const t0 = Date.now(), mp3 = await minimaxTts(text);
            asrState.mmOk = Date.now(); asrState.mmError = '';
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Voice-Engine': 'minimax', 'X-Voice-Ms': String(Date.now() - t0) });
            return res.end(mp3);
          } catch (e) {
            asrState.mmError = String(e.message || e).slice(0, 200);
            asrState.mmDownUntil = Date.now() + 3 * 60000;   // 三分钟内先用别的声音，免得每句话都白等
            console.log('[语音合成] ' + asrState.mmError + '；这几分钟先用' + (ttsReady() ? '豆包' : '本机') + '的声音');
          }
        }
        if (ttsReady()) {
          try {
            const mp3 = await doubaoTts(text);
            asrState.ttsOk = Date.now(); asrState.ttsError = '';
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Voice-Engine': 'doubao' });
            return res.end(mp3);
          } catch (e) {
            asrState.ttsError = String(e.message || e).slice(0, 200);
            asrState.ttsDownUntil = Date.now() + 3 * 60000;   // 三分钟内先用本机的声音，免得每句话都白等
            console.log('[语音合成] ' + asrState.ttsError + '；这几分钟先用本机的声音');
          }
        }
        let r;
        try { r = await fetch(sttUrl + 'tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(60000) }); }
        catch (e) { return json(res, 502, { error: '语音合成服务没有回应' }); }
        if (!r.ok) return json(res, 502, { error: '语音合成出错' });
        res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'audio/wav', 'Cache-Control': 'no-store', 'X-Voice-Engine': 'local' });
        return res.end(Buffer.from(await r.arrayBuffer()));
      }
      if (route === '/clear') { log = log.filter((m) => m.state === 'running'); save(); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'not found' });
    } catch (e) { return json(res, 400, { error: String(e.message || e).slice(0, 160) }); }
  }

  return { handle, tick };
};
