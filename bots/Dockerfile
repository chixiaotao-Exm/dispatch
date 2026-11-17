# Bot 的电脑：一个带桌面和浏览器的隔离容器。
# 里面没有任何服务器的登录凭据，也没有模型密钥；Bot 的"大脑"在调度台那台服务器上，这里只负责执行工具。
FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 TZ=America/New_York \
    PIP_BREAK_SYSTEM_PACKAGES=1 PIP_USER=1 PIP_NO_CACHE_DIR=1 MPLBACKEND=Agg \
    PATH=/home/bot/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox tint2 xterm pcmanfm x11vnc novnc websockify x11-xserver-utils dbus-x11 \
      chromium fonts-noto-cjk fonts-noto-color-emoji locales tzdata \
      xdotool scrot imagemagick poppler-utils \
      python3 python3-pip python3-venv git curl wget jq unzip zip ca-certificates procps less nano \
      python3-numpy python3-pandas python3-matplotlib python3-requests python3-bs4 python3-lxml python3-openpyxl python3-pil python3-docx \
      pandoc sqlite3 ripgrep file tree bc \
    && sed -i 's/^# *zh_CN.UTF-8/zh_CN.UTF-8/' /etc/locale.gen && locale-gen \
    && ln -sf /usr/share/zoneinfo/$TZ /etc/localtime \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash -u 1001 bot
WORKDIR /opt/bot
RUN npm init -y >/dev/null && npm install --omit=dev playwright-core@1.49.1 && npm cache clean --force
# Obscura（无界面浏览器，普通版 + 隐身版）。放在后面，这样不用重装前面那一大堆软件。
COPY install-obscura.sh /tmp/install-obscura.sh
RUN sh /tmp/install-obscura.sh && rm /tmp/install-obscura.sh
COPY bot-tools.js ext-tools.js installer.js entrypoint.sh entrypoint-root.sh /opt/bot/
RUN chmod 755 /opt/bot/entrypoint.sh /opt/bot/entrypoint-root.sh && chmod 644 /opt/bot/bot-tools.js /opt/bot/ext-tools.js /opt/bot/installer.js
# 开机脚本以管理员身份启动安装器，然后降到普通用户 bot 运行其余一切（见 entrypoint-root.sh）。
ENTRYPOINT ["/opt/bot/entrypoint-root.sh"]
