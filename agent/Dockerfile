# 专用 Agent 的独立环境：一个带编程 Agent（Claude Code 和 Codex CLI）、网页终端（ttyd）和 SFTP 的容器。
# Node 22 取自 Node 官方镜像（Claude Code 要求 22 以上，而 Ubuntu 24.04 自带的是 18）。
FROM node:22-bookworm-slim AS node

FROM ubuntu:24.04
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client openssh-server \
      python3 python3-pip python3-venv build-essential \
      tmux ttyd ripgrep jq unzip zip less nano vim-tiny sudo locales procps \
      iputils-ping dnsutils tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && locale-gen zh_CN.UTF-8 en_US.UTF-8
ENV LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 TZ=America/New_York

# 编程 Agent 本体。
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

# 用户：agent 是干活的账号（容器内可 sudo）；files 是只能走 SFTP 的账号，和 agent 同一个 uid，所以文件互通。
RUN userdel -r ubuntu 2>/dev/null || true; \
    useradd -m -u 1000 -s /bin/bash agent \
    && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent && chmod 440 /etc/sudoers.d/agent \
    && useradd -o -u 1000 -g agent -d /workspace -M -s /usr/sbin/nologin files \
    && passwd -l files \
    && mkdir -p /workspace /srv/sftp/workspace /run/sshd /state

COPY sshd_config /etc/ssh/sshd_config
COPY tmux.conf /etc/tmux.conf
COPY files-server.js market.js files-page.html tasks-page.html auto-page.html market-page.html components-page.html ext-apply.js /opt/
COPY srv gmail-send vault publish ext bot /usr/local/bin/
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh /usr/local/bin/srv /usr/local/bin/gmail-send /usr/local/bin/vault /usr/local/bin/publish /usr/local/bin/ext /usr/local/bin/bot && chmod 644 /opt/files-server.js /opt/market.js /opt/files-page.html /opt/tasks-page.html /opt/auto-page.html /opt/market-page.html /opt/components-page.html

EXPOSE 7681 7683 2222
ENTRYPOINT ["/entrypoint.sh"]
