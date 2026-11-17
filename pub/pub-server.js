// 公开网页服务：把 Bot 和专用 Agent "发布"出来的文件，以只读方式提供给外网访问。
//   /a/<发布名>/…  专用 Agent 发布的（它工作目录里的 public 文件夹）
//   /b/<发布名>/…  Bot 发布的（Bot 电脑里的 public 文件夹）
// 只提供静态文件：不执行任何代码，不能上传，不显示隐藏文件，也不会跟着链接跑到这两个文件夹外面。
// 它跑在一个只读、无权限的独立容器里，只监听本机；外面由 Caddy 负责证书和转发。
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PORT = Number(process.env.PORT || 7699);
const ROOTS = { a: process.env.ROOT_A || '/srv/a', b: process.env.ROOT_B || '/srv/b' };
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif;max-width:720px;margin:12vh auto;padding:0 20px;color:#1b2333;background:#f5f6f8}h1{font-size:20px}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}li{padding:2px 0}small{color:#7a8496}
@media (prefers-color-scheme: dark){body{background:#0d1017;color:#e8ecf3}a{color:#7fb0ff}}</style>${body}</html>`;
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
function sendPage(res, status, title, body, head) {
  const data = Buffer.from(page(title, body));
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(head ? undefined : data);
}
const notFound = (res, head) => sendPage(res, 404, '没有这个页面', '<h1>没有这个页面</h1><p>链接可能写错了，或者这份内容已经被撤下。</p>', head);

http.createServer(async (req, res) => {
  const head = req.method === 'HEAD';
  try {
    if (req.method !== 'GET' && !head) { res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD' }); return res.end(); }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return notFound(res, head); }
    if (pathname === '/' || pathname === '/index.html') return sendPage(res, 200, 'Bot 发布站', '<h1>Bot 发布站</h1><p>这里存放 Bot 和 Agent 发布出来的网页与文件。每份内容都有自己的专属链接，需要知道完整链接才能打开。</p>', head);
    if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    const parts = pathname.split('/').filter(Boolean);
    const root = ROOTS[parts[0]];
    // 必须带上发布名（/a/<发布名>/…），不能列出"都发布了什么"；任何一段以 . 开头的都不给。
    if (!root || parts.length < 2 || parts.some((p) => p.startsWith('.') || p.includes('\0') || p.includes('\\'))) return notFound(res, head);
    let abs = path.join(root, ...parts.slice(1));
    let real, st;
    try { real = await fsp.realpath(abs); st = await fsp.stat(real); } catch (e) { return notFound(res, head); }
    let rootReal;
    try { rootReal = await fsp.realpath(root); } catch (e) { return notFound(res, head); }
    if (!real.startsWith(rootReal + path.sep)) return notFound(res, head);   // 链接指到外面去了：不给
    if (st.isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(301, { ...BASE_HEADERS, Location: encodeURI(pathname) + '/' }); return res.end(); }
      const index = path.join(real, 'index.html');
      const ist = await fsp.stat(index).catch(() => null);
      if (ist && ist.isFile()) { real = index; st = ist; }
      else {
        const names = (await fsp.readdir(real, { withFileTypes: true })).filter((e) => !e.name.startsWith('.')).sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name, 'zh')).slice(0, 500);
        return sendPage(res, 200, parts[parts.length - 1], `<h1>${esc(parts.slice(1).join(' / '))}</h1><ul>${names.map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${esc(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`).join('') || '<li><small>（空的）</small></li>'}</ul>`, head);
      }
    }
    if (!st.isFile()) return notFound(res, head);
    const type = TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream';
    const headers = { ...BASE_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(), 'Cache-Control': 'public, max-age=60' };
    if (type === 'application/octet-stream') headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(real))}`;
    const since = req.headers['if-modified-since'];
    if (since && !req.headers.range && Math.floor(st.mtimeMs / 1000) <= Math.floor(Date.parse(since) / 1000)) { res.writeHead(304, headers); return res.end(); }
    let start = 0, end = st.size - 1, status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && st.size > 0 && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), st.size - 1); }
      else start = Math.max(0, st.size - Number(m[2]));
      if (start > end || start >= st.size) { res.writeHead(416, { ...BASE_HEADERS, 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (head || !st.size) return res.end();
    fs.createReadStream(real, { start, end }).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('出错了');
  }
}).listen(PORT, '0.0.0.0', () => console.log('pub server on ' + PORT));
