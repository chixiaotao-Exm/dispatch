#!/bin/bash
# 设置调度台页面的访问密码。在服务器上以 root 运行；密码只写入 /etc/dispatch/env。
set -e
umask 077
ENVF=/etc/dispatch/env

set_env() { # set_env KEY VALUE：只替换这一项，保留文件里的其他设置
  local esc=${2//\\/\\\\}; esc=${esc//\"/\\\"}
  mkdir -p /etc/dispatch; touch "$ENVF"
  grep -v "^$1=" "$ENVF" > "$ENVF.tmp" || true
  printf '%s="%s"\n' "$1" "$esc" >> "$ENVF.tmp"
  chmod 600 "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"
}

echo "请为调度台页面设置一个访问密码（至少 8 位，输入时不显示）。"
while true; do
  read -r -s -p "访问密码: " p1; echo
  if [ "${#p1}" -lt 8 ]; then echo "太短了，至少 8 位，请重新输入。"; continue; fi
  read -r -s -p "再输一次: " p2; echo
  if [ "$p1" != "$p2" ]; then echo "两次不一致，请重新输入。"; continue; fi
  break
done
set_env DASH_PASSWORD "$p1"
systemctl restart dispatch
echo "PASSWORD-SET"
