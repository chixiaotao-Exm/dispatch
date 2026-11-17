#!/bin/bash
# 给 CEO Agent 接入一个 OpenAI /v1 兼容的接口。在服务器上以 root 运行。
# 地址、模型、密钥只写入 /etc/dispatch/env（仅 root 可读），不会显示在页面或日志里。
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

echo "给 CEO Agent 接入大模型（OpenAI /v1 兼容接口）。"
echo
read -r -p "1/3 接口地址（例如 https://你的中转站域名/v1）: " base
base=${base%%[[:space:]]*}
while [ "${base%/}" != "$base" ]; do base=${base%/}; done
case "$base" in
  http://*|https://*) ;;
  *) echo "地址要以 http:// 或 https:// 开头。没有保存任何内容。"; exit 1 ;;
esac
case "$base" in
  */v[0-9]|*/v[0-9][0-9]) ;;
  *) base="$base/v1"; echo "    已自动补上 /v1 → $base" ;;
esac

read -r -p "2/3 模型名称（中转站里的模型 ID）: " model
model=${model//[[:space:]]/}
case "$model" in
  ""|*\"*|*\\*) echo "模型名称为空或含有引号。没有保存任何内容。"; exit 1 ;;
esac

read -r -s -p "3/3 API 密钥（输入时不显示）: " key; echo
key=${key//[[:space:]]/}
[ -n "$key" ] || { echo "密钥为空。没有保存任何内容。"; exit 1; }

echo
echo "正在用这组设置试调用一次…"
out=$(mktemp)
code=$(printf 'header = "Authorization: Bearer %s"\n' "$key" | curl -sS -m 60 -K - -o "$out" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$model\",\"max_tokens\":20,\"messages\":[{\"role\":\"user\",\"content\":\"只回复两个字：正常\"}]}" \
  "$base/chat/completions" 2>"$out.err" || true)
if [ "$code" = "200" ] && grep -q '"choices"' "$out"; then
  echo "试调用成功（HTTP 200）。"
else
  echo "试调用没有成功：HTTP ${code:-无响应}"
  head -c 300 "$out" 2>/dev/null; echo; head -c 300 "$out.err" 2>/dev/null; echo
  rm -f "$out" "$out.err"
  read -r -p "仍然保存这组设置吗？(y/N): " yn
  [ "$yn" = "y" ] || [ "$yn" = "Y" ] || { echo "没有保存任何内容。"; exit 1; }
fi
rm -f "$out" "$out.err"

set_env LLM_BASE_URL "$base"
set_env LLM_MODEL "$model"
set_env LLM_API_KEY "$key"
systemctl restart dispatch
echo "LLM-SET"
