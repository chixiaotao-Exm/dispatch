#!/bin/bash
# 配置专用 Agent 发邮件用的 Gmail 账号。在 Agent 所在的服务器上以 root 运行。
# 地址和"应用专用密码"只写入 /var/lib/agent-ops/gmail.json（只有审批程序的账号能读），不进入 Agent 的容器。
set -e
umask 077
CONF=/var/lib/agent-ops/gmail.json

echo "配置发邮件用的 Gmail 账号。"
echo
echo "这里要填的不是你的 Gmail 登录密码，而是一个 16 位的"应用专用密码"："
echo "  1. 你的 Google 账号要先开启两步验证；"
echo "  2. 打开 https://myaccount.google.com/apppasswords ，起个名字（比如 dispatch），生成；"
echo "  3. 把生成的 16 位密码填到下面（带不带空格都行）。"
echo "以后不想用了，在同一个页面把它删掉即可，不影响你的 Gmail 登录密码。"
echo
read -r -p "1/3 Gmail 地址: " addr
addr=${addr//[[:space:]]/}
case "$addr" in
  *@*.*) ;;
  *) echo "这不像一个邮箱地址。没有保存任何内容。"; exit 1 ;;
esac
read -r -p "2/3 发件人显示的名字（可以留空）: " name
read -r -s -p "3/3 应用专用密码（输入时不显示）: " pass; echo
pass=${pass//[[:space:]]/}
[ -n "$pass" ] || { echo "密码为空。没有保存任何内容。"; exit 1; }

echo
echo "正在用这组信息登录 Gmail 试一下…"
# 密码通过环境变量交给下面的 Python，不出现在命令行里。
if ! result=$(GMAIL_ADDR="$addr" GMAIL_NAME="$name" GMAIL_PASS="$pass" GMAIL_CONF="$CONF" python3 - <<'PY'
import json, os, smtplib, ssl, sys
addr, name, pw, conf = (os.environ[k] for k in ("GMAIL_ADDR", "GMAIL_NAME", "GMAIL_PASS", "GMAIL_CONF"))
try:
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30, context=ssl.create_default_context()) as s:
        s.login(addr, pw)
except smtplib.SMTPAuthenticationError:
    print("Gmail 拒绝登录：地址或应用专用密码不对。注意要用应用专用密码，不是登录密码。"); sys.exit(1)
except Exception as e:
    print("连不上 Gmail：%s" % e); sys.exit(1)
tmp = conf + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump({"address": addr, "name": name, "app_password": pw}, f, ensure_ascii=False)
os.chmod(tmp, 0o600)
os.replace(tmp, conf)
print("登录成功，已保存。")
PY
); then
  echo "$result"
  echo "没有保存任何内容。"
  exit 1
fi
echo "$result"
chown agentops:agentops "$CONF"
chmod 600 "$CONF"
echo
echo "发件邮箱：$addr"
echo "发给这个地址的邮件 Agent 可以直接发；发给其他人的，都要你在调度台上批准。"
echo "GMAIL-SET"
