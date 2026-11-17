#!/usr/bin/env node
// 把正在用的源码"脱敏"后同步到要上传的那份仓库目录里。
// 用法：node tools/sync-repo.js <源码目录> <仓库目录>
// 真实的 IP、域名、姓名写在源码目录的 .sanitize-map.json 里（这个文件只留在本地，不会进仓库），
// 这里按那张表逐条替换成占位值；同步完再检查一遍，仓库目录里只要还剩任何一个真实值或像公网 IP 的东西，就报错退出。
const fs = require('fs');
const path = require('path');

const [src, dst] = process.argv.slice(2).map((p) => path.resolve(p));
if (!src || !dst) { console.error('用法：node tools/sync-repo.js <源码目录> <仓库目录>'); process.exit(2); }
const map = JSON.parse(fs.readFileSync(path.join(src, '.sanitize-map.json'), 'utf8'));   // [[真实值, 占位值], ...]，按顺序替换
const SKIP = new Set(['.git', '.repo', '.claude', 'node_modules', '.sanitize-map.json']);
const KEEP_IN_DST = new Set(['.git']);
const TEXT = /\.(js|json|html|md|py|sh|service|timer|conf|txt|css|yml|yaml)$|(^|\/)(Dockerfile|Caddyfile|sshd_config|[a-z-]+)$/;

function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const rel = base ? base + '/' + name : name, abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, rel)); else out.push(rel);
  }
  return out;
}

// 先清空仓库目录里除 .git 以外的东西，这样源码里删掉的文件在仓库里也会消失。
fs.mkdirSync(dst, { recursive: true });
for (const name of fs.readdirSync(dst)) if (!KEEP_IN_DST.has(name)) fs.rmSync(path.join(dst, name), { recursive: true, force: true });

const files = walk(src);
let replaced = 0;
for (const rel of files) {
  const to = path.join(dst, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (!TEXT.test(rel)) { fs.copyFileSync(path.join(src, rel), to); continue; }
  let s = fs.readFileSync(path.join(src, rel), 'utf8');
  for (const [real, fake] of map) { const n = s.split(real).length - 1; if (n) { replaced += n; s = s.split(real).join(fake); } }
  fs.writeFileSync(to, s);
}

// 复查：仓库目录里不能再有真实值，也不能有保留地址以外的 IP。
const problems = [];
const OK_IP = /^(127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|169\.254\.|255\.)/;
for (const rel of walk(dst)) {
  const s = fs.readFileSync(path.join(dst, rel), 'utf8');
  for (const [real] of map) if (s.includes(real)) problems.push(rel + '：还有没替换掉的真实值');
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g)) {
    if (m.slice(1).some((x) => Number(x) > 255)) continue;                      // 不是 IP（比如版本号的一部分）
    const before = s.slice(Math.max(0, m.index - 12), m.index);
    if (/(version|chrome|v|@|\/)\s*$/i.test(before)) continue;                   // 版本号
    if (!OK_IP.test(m[0])) problems.push(rel + '：像是公网 IP：' + m[0]);
  }
  if (/BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/.test(s)) problems.push(rel + '：像是密钥');
}
if (problems.length) { console.error('脱敏检查没有通过：\n' + problems.join('\n')); process.exit(1); }
console.log(`已同步 ${files.length} 个文件，替换了 ${replaced} 处，脱敏检查通过`);
