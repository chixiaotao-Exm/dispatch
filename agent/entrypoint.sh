#!/bin/bash
# 容器启动脚本：准备目录和 SFTP，然后以 agent 身份启动网页终端。
set -e

# 持久化目录（都挂载自宿主机 /opt/agent/ 下）：
#   /home/agent  Agent 的配置和历史      /workspace  Agent 的工作目录（SFTP 看到的就是这里）
#   /state       SFTP 的主机密钥和密码
chown agent:agent /home/agent /workspace
chown root:root /srv/sftp && chmod 755 /srv/sftp
mkdir -p /state/ssh && chmod 700 /state
[ -f /state/ssh/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N "" -f /state/ssh/ssh_host_ed25519_key
touch /state/sftp_authorized_keys && chmod 644 /state/sftp_authorized_keys

# SFTP 密码：没设置过就保持锁定（无法登录）。密码以哈希形式保存在 /state/sftp.hash。
if [ -s /state/sftp.hash ]; then usermod -p "$(cat /state/sftp.hash)" files; else passwd -l files >/dev/null; fi
/usr/sbin/sshd

# 第一次启动时给 agent 一份默认的 shell 配置。
if [ ! -f /home/agent/.bashrc ]; then
  cp /etc/skel/.bashrc /etc/skel/.profile /home/agent/ 2>/dev/null || true
  cat >> /home/agent/.bashrc <<'EOF'

# ---- 专用 Agent ----
cd /workspace 2>/dev/null
[ -f ~/.agent-env ] && . ~/.agent-env
alias ll='ls -la'
EOF
  chown agent:agent /home/agent/.bashrc /home/agent/.profile 2>/dev/null || true
fi

# 文件管理服务（调度台里的"文件"页）：以 agent 身份运行，只管 /workspace；挂了自动重启。
# 放在独立的会话里（setsid），这样结束 node 进程时不会连带把这个守护循环一起结束。
# 更新代码后要重启它，只结束 node 本身：pkill -u agent -f "^node /opt/files-server.js"
setsid bash -c 'while true; do runuser -u agent -- node /opt/files-server.js; sleep 2; done' &

# 网页终端：路径前缀 /term，由调度台的登录保护；会话放在 tmux 里，断开重连不丢。
exec runuser -u agent -- ttyd -p 7681 -W -b /term \
  -t fontSize=15 -t 'theme={"background":"#0d1017","foreground":"#e8ecf3"}' -t titleFixed=专用Agent \
  tmux new-session -A -s main -c /workspace
