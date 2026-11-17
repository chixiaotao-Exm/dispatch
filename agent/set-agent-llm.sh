#!/bin/bash
# 给专用 Agent 配置大模型（OpenAI /v1/responses 兼容接口）。在 Agent 所在的服务器上以 root 运行。
# 地址和模型写进 Agent 的配置文件，密钥单独放在一个只有 Agent 账号能读的文件里。
set -e
umask 077
HOME_DIR=/opt/agent/home

echo "给专用 Agent 配置大模型。直接按回车使用方括号里的默认值。"
echo
read -r -p "1/3 接口地址 [https://www.example.com/v1]: " base
base=${base%%[[:space:]]*}; base=${base:-https://www.example.com/v1}
while [ "${base%/}" != "$base" ]; do base=${base%/}; done
case "$base" in http://*|https://*) ;; *) echo "地址要以 http:// 或 https:// 开头。没有保存任何内容。"; exit 1 ;; esac
case "$base" in */v[0-9]|*/v[0-9][0-9]) ;; *) base="$base/v1"; echo "    已自动补上 /v1 → $base" ;; esac
case "$base" in *\"*|*\\*) echo "地址里有不允许的字符。没有保存任何内容。"; exit 1 ;; esac

read -r -p "2/3 模型名称 [gpt-6.1-sol]: " model
model=${model//[[:space:]]/}; model=${model:-gpt-6.1-sol}
case "$model" in *\"*|*\\*) echo "模型名称里有不允许的字符。没有保存任何内容。"; exit 1 ;; esac

read -r -s -p "3/3 API 密钥（输入时不显示）: " key; echo
key=${key//[[:space:]]/}
[ -n "$key" ] || { echo "密钥为空。没有保存任何内容。"; exit 1; }

mkdir -p "$HOME_DIR/.codex"
cat > "$HOME_DIR/.codex/config.toml" <<EOF
# 由 set-agent-llm.sh 生成。
model = "$model"
model_provider = "relay"
# Agent 跑在独立容器里，容器本身就是隔离环境，所以容器内不再逐条询问。
sandbox_mode = "danger-full-access"
approval_policy = "never"

[model_providers.relay]
name = "relay"
base_url = "$base"
env_key = "RELAY_API_KEY"
wire_api = "responses"
EOF
esc=${key//\'/\'\\\'\'}
printf "export RELAY_API_KEY='%s'\n" "$esc" > "$HOME_DIR/.agent-env"
chown -R 1000:1000 "$HOME_DIR/.codex" "$HOME_DIR/.agent-env"
chmod 600 "$HOME_DIR/.agent-env" "$HOME_DIR/.codex/config.toml"

echo
echo "正在让 Agent 用这组设置试跑一次（最多等 2 分钟）…"
if out=$(docker exec -u agent agent bash -c '. ~/.agent-env; cd /workspace && timeout 110 codex exec --skip-git-repo-check --color never "只回复两个字：正常" 2>&1'); then
  echo "$out" | tail -4
  echo "试跑成功。"
else
  echo "$out" | tail -6
  echo "试跑没有成功。设置已保存；如果是密钥或模型名填错了，重新运行本脚本即可覆盖。"
fi
# 让网页终端下次打开时是一个带新设置的全新会话。
docker exec -u agent agent tmux kill-server 2>/dev/null || true
echo "AGENT-LLM-SET"
