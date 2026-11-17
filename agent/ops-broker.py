#!/usr/bin/env python3
"""审批中间人：让专用 Agent 能在服务器上执行命令，但每一条都要主人先批准。

它跑在 Agent 容器"外面"（宿主机上），以一个无特权的专用账号运行：
  * 登录三台服务器的密钥只有它拿得到，Agent 的容器里没有；
  * Agent 只能通过一个本地套接字"提交请求"和"查询结果"，不能批准；
  * 批准/拒绝的接口只监听宿主机的 127.0.0.1，容器里访问不到，外面只能经"加密隧道 + 调度台登录"到达。
只用 Python 标准库。
"""
import html as htmllib
import json
import mimetypes
import ops_ext
import os
import re
import secrets
import smtplib
import socket
import ssl
import subprocess
import threading
import time
from email.message import EmailMessage
from email.utils import formataddr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STATE_DIR = os.environ.get("STATE_DIRECTORY", "/var/lib/agent-ops")
SOCK = os.environ.get("OPS_SOCKET", "/opt/agent/home/.ops/ops.sock")
ADMIN_ADDR = ("127.0.0.1", int(os.environ.get("OPS_ADMIN_PORT", "7692")))
KEY = os.path.join(STATE_DIR, "id_ed25519")
KNOWN_HOSTS = os.path.join(STATE_DIR, "known_hosts")
HISTORY = os.path.join(STATE_DIR, "history.json")
HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "servers.json"), encoding="utf-8") as f:
    SERVERS = json.load(f)  # {"名字": {"host": "IP", "label": "显示名", "about": "这台是干什么的"}}
with open(os.path.join(HERE, "ops-page.html"), encoding="utf-8") as f:
    PAGE = f.read()
with open(os.path.join(HERE, "rules-page.html"), encoding="utf-8") as f:
    RULES_PAGE = f.read()
with open(os.path.join(HERE, "vault-page.html"), encoding="utf-8") as f:
    VAULT_PAGE = f.read()

# 发邮件用的 Gmail 账号和"应用专用密码"。只存在这台宿主机上、只有本程序的账号能读；Agent 的容器里没有。
MAIL_CONF = os.path.join(STATE_DIR, "gmail.json")
WORKSPACE_HOST = os.environ.get("AGENT_WORKSPACE", "/opt/agent/workspace")   # 容器里的 /workspace 在宿主机上的位置
MAX_RECIPIENTS = 10
MAX_BODY = 50_000
MAX_ATTACH = 5
MAX_ATTACH_BYTES = 20 * 1024 * 1024
ADDR_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")

PENDING_TTL = 15 * 60   # 等待批准最多 15 分钟，过期作废
RUN_TIMEOUT = 300       # 单条命令最多跑 5 分钟
MAX_PENDING = 5         # 同时最多 5 条待批准，防止刷屏
MAX_CMD = 4000
MAX_OUT = 100_000
KEEP = 200

lock = threading.Lock()
reqs = {}


def now_ms():
    return int(time.time() * 1000)


def load():
    try:
        with open(HISTORY, encoding="utf-8") as f:
            for r in json.load(f):
                if r["status"] == "pending":
                    r["status"] = "expired"
                elif r["status"] == "running":
                    r["status"] = "done"
                    r["exitCode"] = None
                    r["stderr"] = (r.get("stderr") or "") + "\n[审批服务重启，这条命令的结果没有记录下来]"
                reqs[r["id"]] = r
    except (OSError, ValueError, KeyError):
        pass


def save():
    """调用方需持有 lock。"""
    for r in reqs.values():   # 处理完的邮件不再保留排版正文，免得历史文件越来越大
        if r.get("html") and r["status"] not in ("pending", "running"):
            r["html"] = ""
    items = sorted(reqs.values(), key=lambda r: r["createdAt"])[-KEEP:]
    for rid in set(reqs) - {r["id"] for r in items}:
        del reqs[rid]
    tmp = HISTORY + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    os.replace(tmp, HISTORY)


def mail_conf():
    """读 Gmail 配置；没配置或格式不对返回 None。每次用的时候现读，主人改了配置不用重启。"""
    try:
        with open(MAIL_CONF, encoding="utf-8") as f:
            c = json.load(f)
        if ADDR_RE.match(c.get("address", "")) and c.get("app_password"):
            return c
    except (OSError, ValueError):
        pass
    return None


# 发邮件的审批规则。只有主人能在调度台上改；Agent 那一侧没有修改它的接口。
MAIL_POLICY = os.path.join(STATE_DIR, "mail-policy.json")
MAX_DAILY = 200
MAX_ALLOW = 50


def mail_policy():
    """mode: ask=发给别人每封都审批；list=名单里的地址免审批；all=所有收件人都免审批。dailyLimit=24 小时内最多免审批发几封。"""
    p = {"mode": "ask", "allow": [], "dailyLimit": 50}
    try:
        with open(MAIL_POLICY, encoding="utf-8") as f:
            c = json.load(f)
        if c.get("mode") in ("ask", "list", "all"):
            p["mode"] = c["mode"]
        p["allow"] = [a for a in c.get("allow", []) if isinstance(a, str) and ADDR_RE.match(a)][:MAX_ALLOW]
        if isinstance(c.get("dailyLimit"), int) and 1 <= c["dailyLimit"] <= MAX_DAILY:
            p["dailyLimit"] = c["dailyLimit"]
    except (OSError, ValueError, AttributeError):
        pass
    return p


def auto_sent_today(own):
    """过去 24 小时里免审批发给别人的邮件数。调用方需持有 lock。"""
    since = now_ms() - 86400_000
    return sum(1 for r in reqs.values() if r.get("kind") == "mail" and r.get("auto") and r["createdAt"] >= since
               and any(a.lower() != own for a in r.get("to") or []))


# 内置的只读巡检命令：固定写死在这里，Agent 不能改动其中任何一个字，所以不需要审批。
INSPECT_CMD = ('hostname; uptime; echo; free -h; echo; df -hT -x tmpfs -x devtmpfs -x overlay; echo; '
               'echo "== failed services =="; systemctl --failed --no-legend --no-pager 2>/dev/null | head -20; echo; '
               'echo "== top cpu =="; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu | head -8; echo; '
               'echo "== top mem =="; ps -eo pid,user,pcpu,pmem,comm --sort=-pmem | head -8; echo; '
               'echo "== containers =="; if command -v docker >/dev/null 2>&1; then docker ps -a --format "{{.Names}}  {{.Status}}" 2>/dev/null | head -40; else echo "(no docker)"; fi')

# 主人点过"以后这条不再问"的命令：之后同一台服务器上一字不差的同一条命令直接执行。只有主人能增删。
CMD_ALLOW = os.path.join(STATE_DIR, "cmd-allow.json")
MAX_ALLOW_CMDS = 100
allow_cmds = []   # [{"server": "main", "command": "...", "addedAt": 毫秒}]


def load_allow():
    try:
        with open(CMD_ALLOW, encoding="utf-8") as f:
            for a in json.load(f):
                if a.get("server") in SERVERS and isinstance(a.get("command"), str):
                    allow_cmds.append({"server": a["server"], "command": a["command"], "addedAt": a.get("addedAt") or 0})
    except (OSError, ValueError, AttributeError):
        pass


def save_allow():
    """调用方需持有 lock。"""
    tmp = CMD_ALLOW + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(allow_cmds, f, ensure_ascii=False)
    os.replace(tmp, CMD_ALLOW)


def is_allowed(server, command):
    return any(a["server"] == server and a["command"] == command for a in allow_cmds)


# ---- 规则库：主人设的"不允许执行的命令"，以及"命令要不要先给 CEO Agent 审核" ----
# 存在容器外面，Agent 读不到也改不了；只有主人能在调度台上改。
RULES = os.path.join(STATE_DIR, "rules.json")
MAX_RULES = 200
REVIEW_TIMEOUT = 120    # CEO Agent 两分钟没回应，就改为等主人决定
AGENT_NAMES = {"agent": "专用 Agent", "auto": "自动化 Agent"}
DEFAULT_RULES = [
    ("删除系统目录", r"\brm\s+(-[a-z-]+\s+)*(/|/\*|~|/(root|etc|var|usr|home|opt|boot|bin|lib|srv)(/\*)?)(\s|;|&|$)"),
    ("格式化磁盘或直接写磁盘", r"\bmkfs|\bof=/dev/|>\s*/dev/(sd|vd|nvme)"),
    ("关机或重启服务器", r"\b(shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b"),
    ("修改登录密码或用户", r"(^|[;&|]\s*)(sudo\s+)?(passwd|chpasswd|userdel|useradd|usermod)\b"),
    ("修改 SSH 登录方式或登录密钥", r"sshd_config|authorized_keys"),
    ("清空或关闭防火墙", r"\biptables\s+(-F|--flush)|\bufw\s+(disable|reset)|\bnft\s+flush"),
    ("下载脚本并直接执行", r"(curl|wget)[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b"),
    ("把所有文件权限放开", r"\bchmod\s+(-[a-z]+\s+)*777\s+/(\s|$)"),
    ("清除操作记录", r"history\s+-c|>\s*~?/?\S*\.bash_history"),
    ("Fork 炸弹", r":\(\)\s*\{"),
]
lib = {"ceoReview": True, "rules": []}   # rules: [{"id","note","pattern","regex":bool,"scope":"all|agent|auto","enabled":bool}]


def clean_rules(items):
    """校验一组规则；有问题就抛 ValueError（中文说明）。"""
    if not isinstance(items, list) or len(items) > MAX_RULES:
        raise ValueError("规则最多 %d 条" % MAX_RULES)
    out = []
    for i, x in enumerate(items):
        if not isinstance(x, dict):
            raise ValueError("第 %d 条规则格式不对" % (i + 1))
        pattern, note = str(x.get("pattern") or "").strip(), str(x.get("note") or "").strip()[:100]
        if not pattern or len(pattern) > 300:
            raise ValueError("第 %d 条规则的内容为空或太长（最多 300 字）" % (i + 1))
        is_re = x.get("regex") is True
        if is_re:
            try:
                re.compile(pattern)
            except re.error as e:
                raise ValueError("第 %d 条规则的正则表达式写得不对：%s" % (i + 1, e))
        scope = x.get("scope") if x.get("scope") in ("all", "agent", "auto") else "all"
        out.append({"id": str(x.get("id") or secrets.token_hex(4))[:16], "note": note, "pattern": pattern, "regex": is_re,
                    "scope": scope, "enabled": x.get("enabled") is not False})
    return out


def load_lib():
    try:
        with open(RULES, encoding="utf-8") as f:
            c = json.load(f)
        lib["ceoReview"] = c.get("ceoReview") is not False
        lib["rules"] = clean_rules(c.get("rules") or [])
    except FileNotFoundError:
        lib["rules"] = clean_rules([{"note": n, "pattern": p, "regex": True, "scope": "all"} for n, p in DEFAULT_RULES])
    except (OSError, ValueError, AttributeError) as e:
        print("规则库读取失败：%s" % e, flush=True)


def save_lib():
    """调用方需持有 lock。"""
    tmp = RULES + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(lib, f, ensure_ascii=False)
    os.replace(tmp, RULES)


def rule_hit(who, command):
    """命令撞上了规则库里的哪条规则；没撞上返回 None。普通规则按"包含这段文字"算（不分大小写、忽略多余空格）。调用方需持有 lock。"""
    flat = " ".join(command.split())
    for r in lib["rules"]:
        if not r["enabled"] or r["scope"] not in ("all", who):
            continue
        try:
            hit = re.search(r["pattern"], flat, re.I) if r["regex"] else " ".join(r["pattern"].split()).lower() in flat.lower()
        except re.error:
            hit = False
        if hit:
            return r["note"] or r["pattern"]
    return None


# ---- 专用密码 Key ----
# 主人存进来的网站密码、接口密钥等。只存在这台宿主机上、只有本程序的账号能读；Agent 的容器里没有。
# Agent 只能"申请使用某一条"，由 CEO Agent 审核：它批准才交出去，它拒绝、拿不准或没回应都不交。
# 主人自己在审批页也批准不了；存进来的密码不会从任何给网页用的接口再读出来。
VAULT = os.path.join(STATE_DIR, "vault.json")
MAX_SECRETS = 100
MAX_SECRET_LEN = 4000
SECRET_TAKE_SECONDS = 120      # 批准后两分钟内取走，过时作废
SECRET_PER_HOUR = 10           # 同一条密码一小时最多申请 10 次
SECRET_NAME_RE = re.compile(r"^[0-9A-Za-z_\-\u4e00-\u9fff]{1,40}$")
vault = []


def load_vault():
    try:
        with open(VAULT, encoding="utf-8") as f:
            items = json.load(f)
        vault[:] = [e for e in items if isinstance(e, dict) and SECRET_NAME_RE.match(str(e.get("name", ""))) and isinstance(e.get("value"), str)]
    except (OSError, ValueError):
        pass


def save_vault():
    """调用方需持有 lock。"""
    tmp = VAULT + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(vault, f, ensure_ascii=False)
    os.replace(tmp, VAULT)


def vault_find(name):
    return next((e for e in vault if e["name"] == name), None)


def vault_public(e):
    """给网页和 Agent 看的样子：没有密码本身。"""
    return {"name": e["name"], "account": e.get("account", ""), "note": e.get("note", ""), "agents": e.get("agents", "all"),
            "createdAt": e.get("createdAt"), "updatedAt": e.get("updatedAt"), "uses": e.get("uses", 0), "lastUsedAt": e.get("lastUsedAt")}


def attachment_path(p):
    """把 Agent 给的附件路径（容器里的 /workspace/...）换成宿主机上的真实路径；不在工作目录里的一律拒绝。"""
    p = str(p or "")
    if not p.startswith("/workspace/"):
        raise ValueError("附件必须是 /workspace/ 下的文件：" + p)
    root = os.path.realpath(WORKSPACE_HOST)
    real = os.path.realpath(os.path.join(root, p[len("/workspace/"):]))
    if not real.startswith(root + os.sep) or not os.path.isfile(real):
        raise ValueError("附件不存在或不在工作目录里：" + p)
    return real


MAX_HTML = 300_000
# Agent 自己排版的正文里不允许出现的东西：脚本、表单、内嵌页面、外部图片/字体/样式（邮件要自成一体，打开时不去连任何外部地址）。
BAD_HTML = re.compile(r"<\s*(script|iframe|frame|object|embed|form|input|button|link|base|svg|video|audio)\b|<\s*meta[^>]*http-equiv|\bon[a-z]+\s*=|javascript:|vbscript:"
                      r"|\b(src|background|poster|srcset)\s*=\s*[\"']?\s*(https?:)?//|url\(\s*[\"']?\s*(https?:)?//|@import", re.I)


def check_html(h):
    if not isinstance(h, str) or not h.strip():
        raise ValueError("HTML 正文是空的")
    if len(h) > MAX_HTML:
        raise ValueError("HTML 正文太大（最多 %d 字）" % MAX_HTML)
    m = BAD_HTML.search(h)
    if m:
        raise ValueError("HTML 正文里有邮件不允许的内容：%s。不能用脚本、表单、<link>、<svg>、外部图片/字体/样式表，只用表格布局和写在标签上的 style（参考组件库里的邮件模板）" % m.group(0)[:40])


def auto_html(subject, body, sender):
    """没有专门排版的邮件：自动套一个卡片样式——彩色标题栏 + "名称：内容"加粗的正文 + 页脚。"""
    e = htmllib.escape
    alert = re.search(r"告警|异常|失败|错误|故障|宕机|警告|P0|P1", subject)
    good = re.search(r"正常|成功|完成|恢复", subject)
    color = "#ea580c" if alert else "#16a34a" if good else "#3b5bfd"
    rows = []
    for line in body.splitlines():
        t = line.strip()
        if not t:
            rows.append('<div style="height:10px;line-height:10px;font-size:0;">&nbsp;</div>')
            continue
        m = re.match(r"^【(.+?)】\s*(.*)$", t)
        if m:
            rows.append('<div style="font-size:16px;font-weight:bold;color:#111827;margin:14px 0 4px;padding-left:10px;border-left:4px solid %s;">%s</div>' % (color, e(m.group(1))))
            if m.group(2):
                rows.append('<div style="margin:4px 0;">%s</div>' % e(m.group(2)))
            continue
        m = re.match(r"^([①-⑳]|[-•·●]|\d{1,2}[.、)])\s*(.+)$", t)
        if m:
            rows.append('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0;"><tr><td valign="top" style="width:26px;color:%s;font-weight:bold;">%s</td><td>%s</td></tr></table>'
                        % (color, e(m.group(1) if not re.match(r"[-•·●]", m.group(1)) else "●"), e(m.group(2))))
            continue
        m = re.match(r"^([^：:\s/]{1,10})[：:]\s*(\S.*)$", t)
        if m and not m.group(2).startswith("//"):
            rows.append('<div style="margin:8px 0;"><b style="color:#111827;">%s</b>：%s</div>' % (e(m.group(1)), e(m.group(2))))
            continue
        rows.append('<div style="margin:6px 0;">%s</div>' % e(t))
    return ('<html><body style="margin:0;padding:0;background:#f3f4f6;">'
            '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;"><tr><td align="center" style="padding:28px 12px;">'
            '<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;'
            "font-family:'Microsoft YaHei','PingFang SC',Arial,sans-serif;\">"
            '<tr><td bgcolor="%s" style="background:%s;padding:26px 32px;color:#ffffff;font-size:24px;font-weight:bold;line-height:1.4;">%s</td></tr>'
            '<tr><td style="padding:26px 32px 30px;font-size:15px;line-height:1.75;color:#374151;">%s</td></tr>'
            '<tr><td bgcolor="#f9fafb" style="background:#f9fafb;padding:16px 32px;font-size:12px;color:#9ca3af;">这封邮件由 %s 的专用 Agent 自动发出，请不要直接回复。</td></tr>'
            '</table></td></tr></table></body></html>') % (color, color, e(subject), "".join(rows), e(sender or "调度台"))


def mail_html(r, conf):
    return r.get("html") or auto_html(r["subject"], r["body"], (conf or {}).get("name") or "")


def send_mail(r):
    conf = mail_conf()
    if not conf:
        return 1, "", "还没有配置 Gmail 账号，发不出去"
    msg = EmailMessage()
    msg["From"] = formataddr((conf.get("name") or "", conf["address"]))
    msg["To"] = ", ".join(r["to"])
    msg["Subject"] = r["subject"]
    msg.set_content(r["body"])                               # 纯文字版：不显示版式的邮箱看到的是这个
    msg.add_alternative(mail_html(r, conf), subtype="html")   # 带版式的正文
    total = 0
    for p in r.get("attachments") or []:
        real = attachment_path(p)
        total += os.path.getsize(real)
        if total > MAX_ATTACH_BYTES:
            return 1, "", "附件加起来超过 %d MB" % (MAX_ATTACH_BYTES // 1048576)
        ctype = mimetypes.guess_type(real)[0] or "application/octet-stream"
        main, sub = ctype.split("/", 1)
        with open(real, "rb") as f:
            msg.add_attachment(f.read(), maintype=main, subtype=sub, filename=os.path.basename(real))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30, context=ssl.create_default_context()) as smtp:
        smtp.login(conf["address"], conf["app_password"].replace(" ", ""))
        smtp.send_message(msg)
    return 0, "邮件已发出：%s → %s" % (conf["address"], "、".join(r["to"])), ""


def view(r, out_limit=None):
    v = {k: r.get(k) for k in ("id", "kind", "server", "label", "command", "why", "to", "subject", "body", "attachments", "auto", "note", "preset", "agent", "review", "rich",
                               "status", "createdAt", "decidedAt", "endedAt", "exitCode", "secret", "secretNote", "recentAsks", "taken")}
    if out_limit is not None:
        v["stdout"] = (r.get("stdout") or "")[:out_limit]
        v["stderr"] = (r.get("stderr") or "")[:out_limit]
    return v


def clip(b):
    s = b.decode("utf-8", "replace")
    return s if len(s) <= MAX_OUT else s[:MAX_OUT] + "\n…[输出过长，已截断]"


def execute(rid):
    with lock:
        r = reqs[rid]
    if r.get("kind") == "mail":
        try:
            code, out, err = send_mail(r)
        except smtplib.SMTPAuthenticationError:
            code, out, err = 1, "", "Gmail 拒绝登录：地址或应用专用密码不对（也可能是应用专用密码被撤销了）"
        except (smtplib.SMTPException, OSError, ValueError) as e:
            code, out, err = 1, "", "没发出去：%s" % e
        with lock:
            r.update(status="done", exitCode=code, stdout=out, stderr=err, endedAt=now_ms())
            save()
        return
    with lock:
        host, command = SERVERS[r["server"]]["host"], r["command"]
    args = ["ssh", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + KNOWN_HOSTS, "-o", "LogLevel=ERROR",
            "root@" + host, command]
    try:
        p = subprocess.run(args, capture_output=True, timeout=RUN_TIMEOUT, stdin=subprocess.DEVNULL)
        code, out, err = p.returncode, clip(p.stdout), clip(p.stderr)
    except subprocess.TimeoutExpired as e:
        code, out = 124, clip(e.stdout or b"")
        err = clip(e.stderr or b"") + "\n[命令运行超过 %d 秒，已被终止]" % RUN_TIMEOUT
    except OSError as e:
        code, out, err = 255, "", "无法启动 ssh：%s" % e
    with lock:
        r.update(status="done", exitCode=code, stdout=out, stderr=err, endedAt=now_ms())
        save()


def expire_loop():
    while True:
        time.sleep(5)
        cutoff = now_ms() - PENDING_TTL * 1000
        with lock:
            changed = False
            for r in reqs.values():
                rv = r.get("review") or {}
                if r["status"] == "pending" and r.get("kind") == "secret" and r["createdAt"] < now_ms() - REVIEW_TIMEOUT * 1000:
                    rv.update(state="deny", reason="CEO Agent 两分钟内没有回应，密码没有交出去", at=now_ms())
                    r.update(status="denied", decidedAt=now_ms(), endedAt=now_ms())
                    changed = True
                    continue
                if r["status"] == "pending" and rv.get("state") == "waiting" and r["createdAt"] < now_ms() - REVIEW_TIMEOUT * 1000:
                    rv.update(state="timeout", reason="CEO Agent 两分钟内没有回应，改为等你决定", at=now_ms())
                    changed = True
                if r["status"] == "pending" and r["createdAt"] < cutoff:
                    r.update(status="expired", decidedAt=now_ms())
                    changed = True
            if changed:
                save()


class Base(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def address_string(self):
        return "local"

    def send_json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 20000:
            raise ValueError("too large")
        return json.loads(self.rfile.read(n) or b"{}")


class AgentAPI(Base):
    """容器里的 Agent 能访问的接口：只能提交请求、查结果、看服务器列表。"""

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith(("/ext/", "/bot/")):
            return self.ext_get(u)
        if u.path == "/servers":
            return self.send_json(200, {"servers": [{"name": k, "label": v["label"], "about": v.get("about", "")} for k, v in SERVERS.items()]})
        if u.path == "/mail/status":
            conf = mail_conf()
            return self.send_json(200, {"configured": bool(conf), "address": conf["address"] if conf else None})
        if u.path == "/vault/list":   # 有哪些密码可以申请（只有名字和用途，没有密码本身）
            who = "auto" if (parse_qs(u.query).get("agent") or [""])[0] == "auto" else "agent"
            with lock:
                return self.send_json(200, {"secrets": [{"name": e["name"], "note": e.get("note", ""), "hasAccount": bool(e.get("account")),
                                                          "allowed": e.get("agents", "all") in ("all", who)} for e in vault]})
        if u.path == "/vault/take":   # CEO Agent 批准之后，申请它的 Agent 来取；只能取一次
            rid = (parse_qs(u.query).get("id") or [""])[0]
            with lock:
                r = reqs.get(rid)
                if not r or r.get("kind") != "secret":
                    return self.send_json(404, {"error": "没有这条申请"})
                if r["status"] != "done" or (r.get("review") or {}).get("state") != "allow":
                    return self.send_json(409, {"error": "这条申请没有被批准"})
                if r.get("taken"):
                    return self.send_json(410, {"error": "这条申请已经取用过了；还要用就重新申请"})
                if now_ms() - (r.get("decidedAt") or 0) > SECRET_TAKE_SECONDS * 1000:
                    return self.send_json(410, {"error": "批准后超过 %d 秒没有取用，已作废；请重新申请" % SECRET_TAKE_SECONDS})
                e = vault_find(r.get("secret"))
                if not e:
                    return self.send_json(410, {"error": "这条密码已经被主人删除"})
                r.update(taken=True, stdout="Agent 已取用", endedAt=now_ms())
                e["uses"] = e.get("uses", 0) + 1
                e["lastUsedAt"] = now_ms()
                save()
                save_vault()
                return self.send_json(200, {"name": e["name"], "account": e.get("account", ""), "value": e["value"]})
        if u.path == "/result":
            rid = (parse_qs(u.query).get("id") or [""])[0]
            with lock:
                r = reqs.get(rid)
                return self.send_json(200, view(r, MAX_OUT)) if r else self.send_json(404, {"error": "没有这条请求"})
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        route = urlparse(self.path).path
        if route.startswith(("/ext/", "/bot/")):
            return self.ext_post(route)
        if route not in ("/request", "/mail", "/vault/request"):
            return self.send_json(404, {"error": "not found"})
        try:
            body = self.read_json()
        except ValueError:
            return self.send_json(400, {"error": "请求格式不对"})
        if route == "/mail":
            return self.post_mail(body)
        if route == "/vault/request":
            return self.post_secret(body)
        server, command, why = body.get("server"), body.get("command"), str(body.get("why") or "")[:500]
        if server not in SERVERS:
            return self.send_json(400, {"error": "没有这台服务器。可用的：" + "、".join(SERVERS)})
        preset = body.get("preset")
        if preset is not None:
            if preset != "inspect":
                return self.send_json(400, {"error": "没有这个内置命令"})
            command, why = INSPECT_CMD, why or "例行巡检（内置的只读命令）"
        if not isinstance(command, str) or not command.strip() or len(command) > MAX_CMD or "\x00" in command:
            return self.send_json(400, {"error": "命令为空或太长（最多 %d 个字符）" % MAX_CMD})
        with lock:
            who = "auto" if body.get("agent") == "auto" else "agent"
            hit = None if preset == "inspect" else rule_hit(who, command)
            if hit:   # 规则库禁止的命令：谁也批准不了，直接记一笔并拒绝
                rid = secrets.token_hex(8)
                reqs[rid] = {"id": rid, "server": server, "label": SERVERS[server]["label"], "command": command, "why": why,
                             "auto": False, "preset": None, "agent": who, "review": {"state": "rule", "reason": hit, "at": now_ms()},
                             "status": "blocked", "createdAt": now_ms(), "decidedAt": now_ms(), "endedAt": now_ms(),
                             "exitCode": None, "stdout": "", "stderr": ""}
                save()
                return self.send_json(200, {"id": rid, "auto": False, "blocked": hit})
            auto = preset == "inspect" or is_allowed(server, command)
            if not auto and sum(1 for r in reqs.values() if r["status"] == "pending") >= MAX_PENDING:
                return self.send_json(429, {"error": "已经有 %d 条命令在等主人批准，等处理完再提交" % MAX_PENDING})
            if auto and sum(1 for r in reqs.values() if r["status"] == "running") >= 6:
                return self.send_json(429, {"error": "同时在执行的命令太多，等一会儿再提交"})
            rid = secrets.token_hex(8)
            reqs[rid] = {"id": rid, "server": server, "label": SERVERS[server]["label"], "command": command, "why": why,
                         "auto": auto, "preset": preset, "agent": who,
                         "review": {"state": "waiting" if lib["ceoReview"] and not auto else "off", "reason": "", "at": None},
                         "status": "running" if auto else "pending", "createdAt": now_ms(), "decidedAt": now_ms() if auto else None,
                         "endedAt": None, "exitCode": None, "stdout": "", "stderr": ""}
            save()
        if auto:
            threading.Thread(target=execute, args=(rid,), daemon=True).start()
        self.send_json(200, {"id": rid, "auto": auto})


def _post_mail(self, body):
    """Agent 请求发一封邮件。发给主人自己（发件地址本身）的直接发；发给别人的要主人批准。"""
    conf = mail_conf()
    if not conf:
        return self.send_json(400, {"error": "主人还没有配置 Gmail 账号，现在发不了邮件"})
    to = body.get("to")
    to = [to] if isinstance(to, str) else to
    if not isinstance(to, list) or not 1 <= len(to) <= MAX_RECIPIENTS or not all(isinstance(a, str) and ADDR_RE.match(a.strip()) for a in to):
        return self.send_json(400, {"error": "收件人不对：要 1 到 %d 个邮箱地址" % MAX_RECIPIENTS})
    to = [a.strip() for a in to]
    subject, text, why = body.get("subject"), body.get("body"), str(body.get("why") or "")[:500]
    if not isinstance(subject, str) or not subject.strip() or len(subject) > 200 or "\n" in subject or "\r" in subject:
        return self.send_json(400, {"error": "标题为空、太长（最多 200 字）或含有换行"})
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_BODY:
        return self.send_json(400, {"error": "正文为空或太长（最多 %d 字）" % MAX_BODY})
    rich = body.get("html")
    if rich is not None:
        try:
            check_html(rich)
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})
    attachments = body.get("attachments") or []
    if not isinstance(attachments, list) or len(attachments) > MAX_ATTACH:
        return self.send_json(400, {"error": "附件最多 %d 个" % MAX_ATTACH})
    try:
        for p in attachments:
            attachment_path(p)
    except ValueError as e:
        return self.send_json(400, {"error": str(e)})
    own = conf["address"].lower()
    to_self = all(a.lower() == own for a in to)
    pol = mail_policy()
    free = {own} | {a.lower() for a in pol["allow"]}
    auto = to_self or pol["mode"] == "all" or (pol["mode"] == "list" and all(a.lower() in free for a in to))
    note = ""
    with lock:
        if auto and not to_self and auto_sent_today(own) >= pol["dailyLimit"]:
            auto = False   # 超过每日上限：不拒绝，退回到要主人批准
            note = "过去 24 小时免审批已经发了 %d 封，达到你设的上限，所以这封需要你批准。" % pol["dailyLimit"]
        if not auto and sum(1 for r in reqs.values() if r["status"] == "pending") >= MAX_PENDING:
            return self.send_json(429, {"error": "已经有 %d 条请求在等主人批准，等处理完再提交" % MAX_PENDING})
        rid = secrets.token_hex(8)
        reqs[rid] = {"id": rid, "kind": "mail", "server": None, "label": "发邮件", "command": "", "why": why,
                     "to": to, "subject": subject.strip(), "body": text, "attachments": [str(p) for p in attachments], "auto": auto, "note": note, "html": rich or "", "rich": bool(rich),
                     "status": "running" if auto else "pending", "createdAt": now_ms(), "decidedAt": now_ms() if auto else None,
                     "endedAt": None, "exitCode": None, "stdout": "", "stderr": ""}
        save()
    if auto:
        threading.Thread(target=execute, args=(rid,), daemon=True).start()
    self.send_json(200, {"id": rid, "auto": auto})


def _post_secret(self, body):
    """Agent 申请使用密码库里的一条。永远要过 CEO Agent 审核，没有免审批这回事。"""
    name, why = body.get("name"), " ".join(str(body.get("why") or "").split())[:500]
    who = "auto" if body.get("agent") == "auto" else "agent"
    if not isinstance(name, str) or not SECRET_NAME_RE.match(name):
        return self.send_json(400, {"error": "密码名称不对"})
    if len(why) < 6:
        return self.send_json(400, {"error": "必须用 --why 说清楚要拿它做什么（至少 6 个字），CEO Agent 靠这个决定批不批"})
    with lock:
        e = vault_find(name)
        if not e:
            return self.send_json(400, {"error": "密码库里没有「%s」。用 vault list 看有哪些" % name})
        if e.get("agents", "all") not in ("all", who):
            return self.send_json(403, {"error": "主人没有允许%s使用这条密码" % AGENT_NAMES[who]})
        since = now_ms() - 3600_000
        recent = sum(1 for r in reqs.values() if r.get("kind") == "secret" and r.get("secret") == name and r["createdAt"] >= since)
        if recent >= SECRET_PER_HOUR:
            return self.send_json(429, {"error": "这条密码一小时内已经申请了 %d 次，先停下来向主人说明情况" % recent})
        if sum(1 for r in reqs.values() if r["status"] == "pending") >= MAX_PENDING:
            return self.send_json(429, {"error": "已经有 %d 条请求在等审核，等处理完再提交" % MAX_PENDING})
        rid = secrets.token_hex(8)
        reqs[rid] = {"id": rid, "kind": "secret", "secret": name, "secretNote": e.get("note", ""), "recentAsks": recent, "taken": False,
                     "server": None, "label": "密码库", "command": "申请使用密码「%s」" % name, "why": why,
                     "auto": False, "preset": None, "agent": who, "review": {"state": "waiting", "reason": "", "at": None},
                     "status": "pending", "createdAt": now_ms(), "decidedAt": None, "endedAt": None, "exitCode": None, "stdout": "", "stderr": ""}
        save()
    self.send_json(200, {"id": rid})


AgentAPI.post_mail = _post_mail
AgentAPI.post_secret = _post_secret


class AdminAPI(Base):
    """主人用的接口：看待批准的请求和历史，批准或拒绝。只监听宿主机的 127.0.0.1。"""

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/ops/api/ext", "/ops/api/botjobs"):
            return self.ext_admin_get(path)
        if path in ("/ops", "/ops/"):
            data = PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(data)
        if path in ("/ops/rules", "/ops/rules/"):
            data = RULES_PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(data)
        if path in ("/ops/vault", "/ops/vault/"):
            data = VAULT_PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(data)
        if path == "/ops/api/vault":   # 密码库的清单和调用记录；不含密码本身
            with lock:
                log = [view(r) for r in sorted(reqs.values(), key=lambda r: r["createdAt"], reverse=True) if r.get("kind") == "secret"][:40]
                return self.send_json(200, {"entries": [vault_public(e) for e in vault], "log": log, "max": MAX_SECRETS, "takeSeconds": SECRET_TAKE_SECONDS})
        if path == "/ops/api/mail/preview":   # 主人在审批页里预览这封邮件发出去的样子
            rid = (parse_qs(urlparse(self.path).query).get("id") or [""])[0]
            with lock:
                r = reqs.get(rid)
                page = mail_html(r, mail_conf()) if r and r.get("kind") == "mail" and (r.get("html") or not r.get("rich")) else None
            data = (page or "<p style='font:14px sans-serif;color:#888;padding:16px'>这封邮件已经处理完，排版内容不再保留。</p>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            return self.wfile.write(data)
        if path == "/ops/api/rules":
            with lock:
                since = now_ms() - 7 * 86400_000
                blocked = sum(1 for r in reqs.values() if r["status"] == "blocked" and r["createdAt"] >= since)
                return self.send_json(200, {"ceoReview": lib["ceoReview"], "rules": lib["rules"], "blockedWeek": blocked})
        if path == "/ops/api/mail":
            conf = mail_conf()
            return self.send_json(200, {"configured": bool(conf), "address": conf["address"] if conf else None, "name": (conf.get("name") or "") if conf else "",
                                         "policy": mail_policy(), "sentToday": self.sent_today(conf)})
        if path == "/ops/api/list":
            with lock:
                items = sorted(reqs.values(), key=lambda r: r["createdAt"], reverse=True)
                pending = [view(r) for r in reversed(items) if r["status"] == "pending" and r.get("kind") != "secret"]
                waiting_secrets = [view(r) for r in reversed(items) if r["status"] == "pending" and r.get("kind") == "secret"]   # 只归 CEO Agent 审，不进主人的待批准
                recent = [view(r, 6000) for r in items if r["status"] != "pending"][:40]
                for v in pending + recent:
                    if v.get("body") and len(v["body"]) > 8000:
                        v["body"] = v["body"][:8000] + "\n…[正文较长，这里只显示前 8000 字；发出去的是完整内容]"
                extra = EXT_SUMMARY()
                allow = [{"server": a["server"], "label": SERVERS[a["server"]]["label"], "command": a["command"], "addedAt": a["addedAt"]} for a in allow_cmds]
            return self.send_json(200, {"pending": pending, "secrets": waiting_secrets, "recent": recent, "ttlSeconds": PENDING_TTL, "allow": allow, **extra})
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        route = urlparse(self.path).path
        if route.startswith(("/ops/api/ext/", "/ops/api/botjobs/")):
            return self.ext_admin_post(route)
        if route not in ("/ops/api/decide", "/ops/api/mail/save", "/ops/api/mail/clear", "/ops/api/mail/policy", "/ops/api/allow/remove",
                         "/ops/api/rules/save", "/ops/api/review", "/ops/api/vault/save", "/ops/api/vault/delete"):
            return self.send_json(404, {"error": "not found"})
        if self.headers.get("X-Ops-Action") != "1":
            return self.send_json(403, {"error": "请求来源不对"})
        try:
            body = self.read_json()
        except ValueError:
            return self.send_json(400, {"error": "请求格式不对"})
        if route == "/ops/api/mail/save":
            return self.save_mail(body)
        if route == "/ops/api/vault/save":
            return self.save_secret(body)
        if route == "/ops/api/vault/delete":
            with lock:
                before = len(vault)
                vault[:] = [e for e in vault if e["name"] != body.get("name")]
                if len(vault) != before:
                    save_vault()
            return self.send_json(200, {"ok": True})
        if route == "/ops/api/mail/policy":
            return self.save_policy(body)
        if route == "/ops/api/rules/save":
            try:
                rules = clean_rules(body.get("rules"))
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            with lock:
                lib["rules"] = rules
                lib["ceoReview"] = body.get("ceoReview") is not False
                if not lib["ceoReview"]:   # 关掉 CEO 审核时，正在等它的请求改为等主人
                    for r in reqs.values():
                        if r["status"] == "pending" and (r.get("review") or {}).get("state") == "waiting":
                            r["review"].update(state="off")
                    save()
                save_lib()
            return self.send_json(200, {"ok": True, "rules": rules, "ceoReview": lib["ceoReview"]})
        if route == "/ops/api/review":   # CEO Agent 的审核结论（由调度台后端提交）
            verdict, reason = body.get("verdict"), str(body.get("reason") or "")[:300]
            if verdict not in ("allow", "deny", "ask"):
                return self.send_json(400, {"error": "结论不对"})
            with lock:
                r = reqs.get(body.get("id"))
                if not r:
                    return self.send_json(404, {"error": "没有这条请求"})
                rv = r.get("review") or {}
                if r["status"] != "pending" or rv.get("state") != "waiting" or r.get("kind") == "mail":
                    return self.send_json(409, {"error": "这条请求不在等 CEO Agent 审核"})
                if r.get("kind") == "secret":   # 密码：CEO Agent 批准才交出去；拒绝或拿不准都不交，也不转给主人
                    if verdict == "allow":
                        rv.update(state="allow", reason=reason, at=now_ms())
                        r.update(status="done", exitCode=0, decidedAt=now_ms(), stdout="CEO Agent 已批准，等 Agent 取用")
                    else:
                        rv.update(state="deny", reason=reason or "CEO Agent 拿不准，没有交出去", at=now_ms())
                        r.update(status="denied", decidedAt=now_ms(), endedAt=now_ms())
                    save()
                    return self.send_json(200, {"ok": True})
                rv.update(state=verdict, reason=reason, at=now_ms())
                if verdict == "allow":
                    r.update(status="running", decidedAt=now_ms())
                elif verdict == "deny":
                    r.update(status="denied", decidedAt=now_ms())
                save()
            if verdict == "allow":
                threading.Thread(target=execute, args=(r["id"],), daemon=True).start()
            return self.send_json(200, {"ok": True})
        if route == "/ops/api/allow/remove":
            with lock:
                before = len(allow_cmds)
                allow_cmds[:] = [a for a in allow_cmds if not (a["server"] == body.get("server") and a["command"] == body.get("command"))]
                if len(allow_cmds) != before:
                    save_allow()
            return self.send_json(200, {"ok": True})
        if route == "/ops/api/mail/clear":
            try:
                os.unlink(MAIL_CONF)
            except FileNotFoundError:
                pass
            return self.send_json(200, {"ok": True})
        with lock:
            r = reqs.get(body.get("id"))
            if not r:
                return self.send_json(404, {"error": "没有这条请求"})
            if r["status"] != "pending":
                return self.send_json(409, {"error": "这条请求已经处理过了"})
            if r.get("kind") == "secret":
                return self.send_json(400, {"error": "密码的调用只能由 CEO Agent 批准"})
            approve = body.get("approve") is True
            if approve and body.get("always") is True:
                if r.get("kind") == "mail":
                    return self.send_json(400, {"error": "邮件不能设成以后都允许；请在发邮件设置里改审批方式"})
                if not is_allowed(r["server"], r["command"]):
                    if len(allow_cmds) >= MAX_ALLOW_CMDS:
                        return self.send_json(400, {"error": "免审批的命令最多 %d 条，先删掉一些不用的" % MAX_ALLOW_CMDS})
                    allow_cmds.append({"server": r["server"], "command": r["command"], "addedAt": now_ms()})
                    save_allow()
            r.update(status="running" if approve else "denied", decidedAt=now_ms())
            save()
        if approve:
            threading.Thread(target=execute, args=(r["id"],), daemon=True).start()
        self.send_json(200, {"ok": True})


_last_login_try = [0.0]


def _save_mail(self, body):
    """主人在调度台网页上填的 Gmail 地址和应用专用密码：先实际登录一次，登录成功才保存。密码不会从任何接口再读出来。"""
    addr = str(body.get("address") or "").strip()
    name = str(body.get("name") or "").strip()[:60]
    pw = "".join(str(body.get("app_password") or "").split())
    if not ADDR_RE.match(addr):
        return self.send_json(400, {"error": "这不像一个邮箱地址"})
    if not pw or len(pw) > 100:
        return self.send_json(400, {"error": "请填写应用专用密码"})
    with lock:
        if time.time() - _last_login_try[0] < 5:   # 防止被拿来反复试密码
            return self.send_json(429, {"error": "试得太频繁了，过几秒再点"})
        _last_login_try[0] = time.time()
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30, context=ssl.create_default_context()) as smtp:
            smtp.login(addr, pw)
    except smtplib.SMTPAuthenticationError:
        return self.send_json(400, {"error": "Gmail 拒绝登录。请确认填的是 16 位的「应用专用密码」（不是 Gmail 登录密码），并且地址没有写错。"})
    except (smtplib.SMTPException, OSError) as e:
        return self.send_json(502, {"error": "连不上 Gmail：%s" % e})
    tmp = MAIL_CONF + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"address": addr, "name": name, "app_password": pw}, f, ensure_ascii=False)
    os.replace(tmp, MAIL_CONF)
    self.send_json(200, {"ok": True, "address": addr})


def _save_secret(self, body):
    """主人在网页上新增或修改一条密码。修改时密码留空表示不改密码本身。"""
    name = str(body.get("name") or "").strip()
    orig = str(body.get("orig") or "").strip()
    account = str(body.get("account") or "").strip()
    note = " ".join(str(body.get("note") or "").split())
    value = body.get("value")
    value = value.strip("\r\n") if isinstance(value, str) else ""
    agents = body.get("agents")
    if not SECRET_NAME_RE.match(name):
        return self.send_json(400, {"error": "名称只能用中文、字母、数字、下划线和短横线，最多 40 个字，不能有空格"})
    if len(account) > 200 or len(note) > 300:
        return self.send_json(400, {"error": "账号最多 200 字，用途说明最多 300 字"})
    if len(note) < 4:
        return self.send_json(400, {"error": "请写清楚这条密码是做什么用的（CEO Agent 靠它判断该不该批准）"})
    if len(value) > MAX_SECRET_LEN or "\x00" in value:
        return self.send_json(400, {"error": "密码太长（最多 %d 个字符）" % MAX_SECRET_LEN})
    if agents not in ("all", "agent", "auto"):
        return self.send_json(400, {"error": "「谁可以申请」选得不对"})
    with lock:
        cur = vault_find(orig) if orig else None
        if orig and not cur:
            return self.send_json(404, {"error": "要修改的那条已经不存在了，刷新页面再试"})
        if name != orig and vault_find(name):
            return self.send_json(400, {"error": "已经有一条叫「%s」的了" % name})
        if cur:
            cur.update(name=name, account=account, note=note, agents=agents, updatedAt=now_ms())
            if value:
                cur["value"] = value
        else:
            if not value:
                return self.send_json(400, {"error": "请填写密码"})
            if len(vault) >= MAX_SECRETS:
                return self.send_json(400, {"error": "最多存 %d 条" % MAX_SECRETS})
            vault.append({"name": name, "account": account, "note": note, "agents": agents, "value": value,
                          "createdAt": now_ms(), "updatedAt": now_ms(), "uses": 0, "lastUsedAt": None})
        save_vault()
        return self.send_json(200, {"ok": True, "entries": [vault_public(e) for e in vault]})


AdminAPI.save_mail = _save_mail
AdminAPI.save_secret = _save_secret


def _sent_today(self, conf):
    if not conf:
        return 0
    with lock:
        return auto_sent_today(conf["address"].lower())


def _save_policy(self, body):
    mode = body.get("mode")
    if mode not in ("ask", "list", "all"):
        return self.send_json(400, {"error": "审批方式不对"})
    allow = body.get("allow") or []
    if isinstance(allow, str):
        allow = re.split(r"[\s,;，；、]+", allow)
    if not isinstance(allow, list):
        return self.send_json(400, {"error": "名单格式不对"})
    allow = [a.strip() for a in allow if isinstance(a, str) and a.strip()]
    bad = [a for a in allow if not ADDR_RE.match(a)]
    if bad:
        return self.send_json(400, {"error": "这个不像邮箱地址：%s" % bad[0][:80]})
    allow = list(dict.fromkeys(a.lower() for a in allow))
    if len(allow) > MAX_ALLOW:
        return self.send_json(400, {"error": "名单最多 %d 个地址" % MAX_ALLOW})
    if mode == "list" and not allow:
        return self.send_json(400, {"error": "选了「名单内免审批」，但名单是空的"})
    limit = body.get("dailyLimit")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_DAILY:
        return self.send_json(400, {"error": "每天上限要填 1 到 %d 之间的整数" % MAX_DAILY})
    tmp = MAIL_POLICY + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"mode": mode, "allow": allow, "dailyLimit": limit}, f, ensure_ascii=False)
    os.replace(tmp, MAIL_POLICY)
    self.send_json(200, {"ok": True, "policy": mail_policy()})


AdminAPI.sent_today = _sent_today
AdminAPI.save_policy = _save_policy


class UnixServer(ThreadingHTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True

    def server_bind(self):
        try:
            os.unlink(self.server_address)
        except FileNotFoundError:
            pass
        self.socket.bind(self.server_address)
        os.chmod(self.server_address, 0o666)
        self.server_name, self.server_port = "ops", 0


EXT_SUMMARY = ops_ext.setup(globals())   # 扩展申请、委托 Bot（见 ops_ext.py）


def main():
    load()
    load_allow()
    load_lib()
    load_vault()
    threading.Thread(target=expire_loop, daemon=True).start()
    agent = UnixServer(SOCK, AgentAPI)
    threading.Thread(target=agent.serve_forever, daemon=True).start()
    admin = ThreadingHTTPServer(ADMIN_ADDR, AdminAPI)
    admin.daemon_threads = True
    print("ops broker: agent socket %s, admin %s:%d, servers: %s" % (SOCK, ADMIN_ADDR[0], ADMIN_ADDR[1], ", ".join(SERVERS)), flush=True)
    admin.serve_forever()


if __name__ == "__main__":
    main()
