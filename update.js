// 版本和在线更新：首页右上角显示当前版本；"检查更新"去 GitHub 仓库看有没有新版本；
// "更新"只是在存档目录里留一张"请更新"的条子——真正替换文件、重启的是另一个有权限的更新程序（update/update.py），
// 调度台自己没有权限改自己的代码。更新程序会先备份，新版本起不来就自动退回旧版本。
const fs = require('fs');
const path = require('path');

module.exports = function (ctx) {
  const { dir, stateDir, repo, branch } = ctx;
  const requestFile = path.join(stateDir, 'update-request');
  const statusFile = path.join(stateDir, 'update-status.json');
  const clean = (j) => ({ version: String(j.version || '').slice(0, 20), date: String(j.date || '').slice(0, 20), notes: String(j.notes || '').slice(0, 400) });
  const current = () => { try { return clean(JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'))); } catch (e) { return { version: '未知', date: '', notes: '' }; } };
  // 版本号按数字比较：1.10.0 比 1.9.0 新。
  const newer = (a, b) => {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
    return false;
  };
  let latest = null, checkedAt = 0, checkError = '';

  async function check() {
    if (!repo) { checkError = '还没有配置更新来源'; return; }
    try {
      // 先问 GitHub 的接口（不走缓存），不行再读原始文件。
      let res = await fetch(`https://api.github.com/repos/${repo}/contents/version.json?ref=${branch}`, { headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'dispatch-updater' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/version.json`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('GitHub 返回 ' + res.status);
      latest = clean(JSON.parse(await res.text()));
      checkError = '';
    } catch (e) { checkError = '没有查到：' + String(e.message || e).slice(0, 100); }
    checkedAt = Date.now();
  }

  function status() {
    const cur = current();
    let last = null;
    try { last = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch (e) { /* 还没更新过 */ }
    const running = fs.existsSync(requestFile) || Boolean(last && last.state === 'running' && Date.now() - last.at < 10 * 60000);
    return { current: cur, latest, checkedAt, checkError, hasUpdate: Boolean(latest && latest.version && cur.version !== '未知' && newer(latest.version, cur.version)), running, last, configured: Boolean(repo) };
  }

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  async function handle(req, res, pathname) {
    try {
      const route = pathname.slice('/api/update'.length);
      if (req.method === 'GET' && route === '/status') return json(res, 200, status());
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      if (req.headers['x-update-action'] !== '1') return json(res, 403, { error: '请求来源不对' });
      if (route === '/check') { await check(); return json(res, 200, status()); }
      if (route === '/apply') {
        await check();
        const s = status();
        if (s.running) return json(res, 409, { error: '已经在更新了' });
        if (s.checkError) return json(res, 502, { error: s.checkError });
        if (!s.hasUpdate) return json(res, 400, { error: '已经是最新版本' });
        fs.writeFileSync(requestFile, JSON.stringify({ at: Date.now(), from: s.current.version, to: s.latest.version }));
        console.log(`[更新] 主人点了更新：v${s.current.version} → v${s.latest.version}`);
        return json(res, 200, { ok: true, to: s.latest.version });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) { return json(res, 500, { error: String(e.message || e).slice(0, 160) }); }
  }

  setTimeout(check, 20000);
  setInterval(check, 6 * 3600000);
  console.log(`当前版本：v${current().version}`);
  return { handle, status };
};
