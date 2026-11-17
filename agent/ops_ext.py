"""审批中间人的两项扩展功能（由 ops-broker.py 加载）：

1. 扩展申请：专用 Agent / 自动化 Agent 想给自己的工作环境加装工具、技能或 MCP 服务时在这里登记。
   调度台那边的 CEO Agent 审批（只看会不会影响现有系统），批准后由"开发者"决定怎么装。
   系统软件包由本程序去装（Agent 自己没有管理员权限）；技能和 MCP 由调度台交给 Agent 环境里的文件服务去装。
2. 委托 Bot：Agent 把一件需要浏览器、桌面的事交给某个 Bot 去做。这里只负责排队和传话，
   调度台那边取走任务、交给 Bot、再把结果送回来。

Agent 一侧只能"提交"和"查结果"；审批、安装、回填结果的接口都在只监听宿主机 127.0.0.1 的管理端口上。
"""
import json
import os
import re
import secrets
import shlex
import subprocess
import time
from urllib.parse import parse_qs

KINDS = {"tool": "工具", "skill": "技能", "mcp": "MCP 服务"}
PKG_RE = {
    "apt": re.compile(r"^[a-z0-9][a-z0-9+.\-]{1,60}$"),
    "pip": re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,60}(\[[A-Za-z0-9,_\-]{1,40}\])?(==[A-Za-z0-9.]{1,20})?$"),
    "npm": re.compile(r"^(@[a-z0-9][a-z0-9._\-]{0,40}/)?[a-z0-9][a-z0-9._\-]{0,60}(@[A-Za-z0-9.^~\-]{1,20})?$"),
}
# 会动到 Agent 环境的根基、往外开口子，或者是扫描攻击类的：谁批准都不装。
NEVER = re.compile(r"^(sudo|doas|docker.*|podman.*|containerd.*|lxc.*|openssh-server|dropbear.*|telnetd|systemd.*|linux-image.*|linux-headers.*|kmod|iptables|nftables|ufw|"
                   r"wireguard.*|openvpn|tor|nmap|masscan|hydra|john|hashcat|aircrack.*|metasploit.*|sqlmap|nodejs|node|python3|python3-minimal|libc6|apt|dpkg|bash|coreutils|"
                   r"claude.*|@anthropic-ai/.*)$", re.I)
MAX_OPEN = 3            # 同时在走流程的申请
PER_HOUR = 8
REVIEW_TIMEOUT = 180    # CEO Agent 三分钟没回应：不批准
INSTALL_TIMEOUT = 300   # 批准后五分钟没人来装：算失败
JOB_WAIT = 20 * 60      # 委托给 Bot 的事最多等 20 分钟
JOB_PER_HOUR = 20


def setup(g):
    lock, now_ms, SERVERS = g["lock"], g["now_ms"], g["SERVERS"]
    STATE_DIR, KEY, KNOWN_HOSTS = g["STATE_DIR"], g["KEY"], g["KNOWN_HOSTS"]
    AgentAPI, AdminAPI, AGENT_NAMES = g["AgentAPI"], g["AdminAPI"], g["AGENT_NAMES"]
    FILE = os.path.join(STATE_DIR, "ext.json")
    AGENT_SERVER = os.environ.get("OPS_AGENT_SERVER", "ny")       # Agent 的容器所在的那台服务器
    AGENT_CONTAINER = os.environ.get("OPS_AGENT_CONTAINER", "agent")
    ext = {}      # id → 申请
    jobs = {}     # id → 委托给 Bot 的事
    bots = {"at": 0, "list": []}   # 调度台定时告诉这里现在有哪些 Bot

    try:
        with open(FILE, encoding="utf-8") as f:
            for r in json.load(f):
                if r["state"] in ("waiting", "approved", "installing"):
                    r.update(state="failed", result="审批服务重启，这条申请没有走完", endedAt=now_ms())
                ext[r["id"]] = r
    except (OSError, ValueError, KeyError):
        pass

    def save():
        """调用方需持有 lock。"""
        items = sorted(ext.values(), key=lambda r: r["createdAt"])[-200:]
        for rid in set(ext) - {r["id"] for r in items}:
            del ext[rid]
        tmp = FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
        os.replace(tmp, FILE)

    def tidy():
        """把超时的申请和委托收尾。调用方需持有 lock。"""
        t, changed = now_ms(), False
        for r in ext.values():
            if r["state"] == "waiting" and t - r["createdAt"] > REVIEW_TIMEOUT * 1000:
                r.update(state="denied", review={"verdict": "deny", "reason": "CEO Agent 三分钟内没有回应，没有批准", "at": t}, endedAt=t)
                changed = True
            elif r["state"] == "approved" and t - r.get("approvedAt", r["createdAt"]) > INSTALL_TIMEOUT * 1000:
                r.update(state="failed", result="开发者五分钟内没有给出安装方案", endedAt=t)
                changed = True
        if changed:
            save()
        for j in list(jobs.values()):
            if j["state"] in ("queued", "running") and t - j["createdAt"] > JOB_WAIT * 1000:
                j.update(state="failed", result="等了 20 分钟还没有结果，已放弃", endedAt=t)
            if t - j["createdAt"] > 3 * 3600 * 1000:
                del jobs[j["id"]]

    def who_of(body):
        return "auto" if body.get("agent") == "auto" else "agent"

    # ------------------------------------------------------------------ Agent 一侧
    def agent_get(self, u):
        q = parse_qs(u.query)
        rid = (q.get("id") or [""])[0]
        with lock:
            tidy()
            if u.path == "/ext/result":
                r = ext.get(rid)
                return self.send_json(200, r) if r else self.send_json(404, {"error": "没有这条申请"})
            if u.path == "/ext/list":
                return self.send_json(200, {"requests": sorted(ext.values(), key=lambda r: r["createdAt"], reverse=True)[:20]})
            if u.path == "/bot/result":
                j = jobs.get(rid)
                return self.send_json(200, j) if j else self.send_json(404, {"error": "没有这条委托"})
            if u.path == "/bot/list":
                fresh = now_ms() - bots["at"] < 60000
                return self.send_json(200, {"bots": bots["list"], "fresh": fresh})
        self.send_json(404, {"error": "not found"})

    def agent_post(self, route):
        try:
            body = self.read_json()
        except ValueError:
            return self.send_json(400, {"error": "请求格式不对"})
        who = who_of(body)
        flat = lambda v, n: " ".join(str(v or "").split())[:n]
        if route == "/ext/request":
            kind, name, why, source = body.get("kind"), flat(body.get("name"), 80), flat(body.get("why"), 600), flat(body.get("source"), 400)
            if kind not in KINDS:
                return self.send_json(400, {"error": "类型只能是 tool、skill 或 mcp"})
            if len(name) < 2:
                return self.send_json(400, {"error": "要写清楚想要的东西叫什么"})
            if len(why) < 8:
                return self.send_json(400, {"error": "必须用 --why 说清楚拿它做什么，CEO Agent 和开发者都要看这个"})
            with lock:
                tidy()
                if sum(1 for r in ext.values() if r["state"] in ("waiting", "approved", "installing")) >= MAX_OPEN:
                    return self.send_json(429, {"error": "已经有 %d 条申请在走流程，等它们结束再提交" % MAX_OPEN})
                if sum(1 for r in ext.values() if r["createdAt"] > now_ms() - 3600_000) >= PER_HOUR:
                    return self.send_json(429, {"error": "这一小时已经申请了 %d 次，先停下来向主人说明你需要什么" % PER_HOUR})
                rid = secrets.token_hex(6)
                ext[rid] = {"id": rid, "agent": who, "who": AGENT_NAMES[who], "kind": kind, "name": name, "purpose": why, "source": source,
                            "state": "waiting", "createdAt": now_ms(), "review": None, "plans": [], "result": ""}
                save()
            return self.send_json(200, {"id": rid})
        if route == "/bot/ask":
            bot, text = flat(body.get("bot"), 60), str(body.get("text") or "").strip()
            if not bot:
                return self.send_json(400, {"error": "要写明交给哪个 Bot（用 bot list 看有哪些）"})
            if len(text) < 6 or len(text) > 5000:
                return self.send_json(400, {"error": "任务说明太短或太长（6 到 5000 字）"})
            with lock:
                tidy()
                if sum(1 for j in jobs.values() if j["state"] in ("queued", "running")) >= 2:
                    return self.send_json(429, {"error": "已经有两件事交给 Bot 在做，等它们做完再交"})
                if sum(1 for j in jobs.values() if j["createdAt"] > now_ms() - 3600_000) >= JOB_PER_HOUR:
                    return self.send_json(429, {"error": "这一小时交给 Bot 的事太多了，先停一停"})
                jid = secrets.token_hex(6)
                jobs[jid] = {"id": jid, "agent": who, "who": AGENT_NAMES[who], "bot": bot, "text": text, "state": "queued", "status": "排队中",
                             "createdAt": now_ms(), "result": "", "links": [], "botName": ""}
            return self.send_json(200, {"id": jid})
        self.send_json(404, {"error": "not found"})

    # ------------------------------------------------------------------ 安装系统软件包（进 Agent 的容器，以管理员身份）
    def ssh(remote, timeout):
        host = SERVERS[AGENT_SERVER]["host"]
        args = ["ssh", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes",
                "-o", "UserKnownHostsFile=" + KNOWN_HOSTS, "-o", "LogLevel=ERROR", "root@" + host, remote]
        try:
            p = subprocess.run(args, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
            return p.returncode == 0, (p.stdout + p.stderr).decode("utf-8", "replace").strip()[-6000:]
        except subprocess.TimeoutExpired:
            return False, "超过 %d 秒没有装完，已终止" % timeout
        except OSError as e:
            return False, "无法启动 ssh：%s" % e

    def install_packages(method, packages, verify):
        if method not in PKG_RE:
            return False, "安装方式只能是 apt、pip 或 npm"
        if not isinstance(packages, list) or not 1 <= len(packages) <= 8:
            return False, "要给 1 到 8 个包名"
        for p in packages:
            if not isinstance(p, str) or not PKG_RE[method].match(p):
                return False, "包名不合规：%s" % str(p)[:60]
            if NEVER.match(re.split(r"[=\[]|(?<=.)@", p)[0]):
                return False, "这个包不允许安装：%s" % p
        if AGENT_SERVER not in SERVERS:
            return False, "不知道 Agent 的容器在哪台服务器上"
        pk = " ".join(shlex.quote(p) for p in packages)
        dx = "docker exec -u 0 -e DEBIAN_FRONTEND=noninteractive %s " % shlex.quote(AGENT_CONTAINER)
        if method == "apt":
            remote = dx + "sh -c " + shlex.quote("apt-get update -q >/dev/null 2>&1; apt-get install -y -q --no-install-recommends -- " + pk)
        elif method == "pip":
            remote = dx + "pip3 install --break-system-packages --no-input --no-cache-dir -- " + pk
        else:
            remote = dx + "npm install -g --no-fund --no-audit -- " + pk
        ok, log = ssh(remote, 600)
        if ok and isinstance(verify, str) and verify.strip():   # 装完以 Agent 的身份试跑一下
            v = verify.strip()[:300]
            vok, vlog = ssh("docker exec -u agent %s bash -lc %s" % (shlex.quote(AGENT_CONTAINER), shlex.quote(v)), 90)
            if not vok:
                return False, "装上了，但核验命令没通过（%s）：\n%s" % (v, vlog[-800:])
            log = "核验通过：" + v
        return ok, log

    # ------------------------------------------------------------------ 调度台一侧（管理端口）
    def admin_get(self, path):
        with lock:
            tidy()
            if path == "/ops/api/ext":
                return self.send_json(200, {"requests": sorted(ext.values(), key=lambda r: r["createdAt"], reverse=True)[:60]})
            if path == "/ops/api/botjobs":
                return self.send_json(200, {"jobs": sorted(jobs.values(), key=lambda j: j["createdAt"], reverse=True)[:40]})
        self.send_json(404, {"error": "not found"})

    def admin_post(self, route):
        if self.headers.get("X-Ops-Action") != "1":
            return self.send_json(403, {"error": "请求来源不对"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 400000:
                raise ValueError("too large")
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.send_json(400, {"error": "请求格式不对"})
        if route == "/ops/api/botjobs/bots":       # 调度台告诉这里现在有哪些 Bot
            with lock:
                bots.update(at=now_ms(), list=[{"name": str(b.get("name"))[:40], "model": str(b.get("model"))[:60], "busy": bool(b.get("busy"))} for b in (body.get("bots") or [])[:20]])
            return self.send_json(200, {"ok": True})
        if route == "/ops/api/botjobs/update":     # 调度台回填委托的进展和结果
            with lock:
                j = jobs.get(body.get("id"))
                if not j:
                    return self.send_json(404, {"error": "没有这条委托"})
                if j["state"] in ("done", "failed"):
                    return self.send_json(409, {"error": "这条委托已经结束"})
                if body.get("state") in ("running", "done", "failed"):
                    j["state"] = body["state"]
                for k, lim in (("status", 200), ("botName", 40), ("result", 30000)):
                    if isinstance(body.get(k), str):
                        j[k] = body[k][:lim]
                if isinstance(body.get("links"), list):
                    j["links"] = [str(x)[:500] for x in body["links"][:20]]
                if j["state"] in ("done", "failed"):
                    j["endedAt"] = now_ms()
            return self.send_json(200, {"ok": True})
        with lock:
            r = ext.get(body.get("id"))
            if not r:
                return self.send_json(404, {"error": "没有这条申请"})
            if route == "/ops/api/ext/review":     # CEO Agent 的结论
                if r["state"] != "waiting":
                    return self.send_json(409, {"error": "这条申请不在等审批"})
                allow = body.get("verdict") == "allow"
                r["review"] = {"verdict": "allow" if allow else "deny", "reason": str(body.get("reason") or "")[:300] or ("不影响现有系统" if allow else "没有说明原因"), "at": now_ms()}
                r["state"] = "approved" if allow else "denied"
                r["approvedAt"] = now_ms()
                if not allow:
                    r["endedAt"] = now_ms()
                save()
                return self.send_json(200, {"ok": True})
            if route == "/ops/api/ext/begin":      # 开发者开始按一个方案安装
                if r["state"] != "approved":
                    return self.send_json(409, {"error": "这条申请现在不能安装（状态：%s）" % r["state"]})
                if len(r["plans"]) >= 2:
                    return self.send_json(409, {"error": "这条申请的安装次数用完了"})
                plan = body.get("plan") if isinstance(body.get("plan"), dict) else {}
                r["plans"].append({k: plan.get(k) for k in ("method", "packages", "name", "repo", "path", "command", "args", "note", "by") if plan.get(k) is not None} | {"at": now_ms()})
                r["state"] = "installing"
                save()
                return self.send_json(200, {"ok": True})
            if route == "/ops/api/ext/finish":     # 这一次安装的结果
                if r["state"] != "installing":
                    return self.send_json(409, {"error": "这条申请不在安装中"})
                ok, final = body.get("ok") is True, body.get("final") is True
                if r["plans"]:
                    r["plans"][-1].update(ok=ok, log=str(body.get("log") or "")[:1500])
                if ok:
                    r.update(state="installed", result=str(body.get("result") or "")[:600], endedAt=now_ms())
                elif final:
                    r.update(state="failed", result=str(body.get("log") or "安装失败")[:600], endedAt=now_ms())
                else:
                    r.update(state="approved", approvedAt=now_ms())
                save()
                return self.send_json(200, {"ok": True})
            if route != "/ops/api/ext/install":
                return self.send_json(404, {"error": "not found"})
            if r["state"] != "installing" or r["kind"] != "tool":
                return self.send_json(409, {"error": "这条申请现在不能装软件包"})
        ok, log = install_packages(body.get("method"), body.get("packages"), body.get("verify"))   # 这一步可能要几分钟，不能占着锁
        self.send_json(200, {"ok": ok, "log": log})

    AgentAPI.ext_get, AgentAPI.ext_post = agent_get, agent_post
    AdminAPI.ext_admin_get, AdminAPI.ext_admin_post = admin_get, admin_post

    def summary():
        """给 /ops/api/list 顺带带上，调度台首页画光点用。调用方需持有 lock。"""
        tidy()
        return {"ext": [{k: r.get(k) for k in ("id", "agent", "who", "kind", "name", "state", "review", "result", "createdAt")} for r in sorted(ext.values(), key=lambda r: r["createdAt"], reverse=True)[:20]],
                "botjobs": [{k: j.get(k) for k in ("id", "agent", "bot", "botName", "state", "status", "createdAt")} for j in sorted(jobs.values(), key=lambda j: j["createdAt"], reverse=True)[:20]]}
    return summary
