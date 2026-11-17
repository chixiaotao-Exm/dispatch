#!/bin/bash
# 这台电脑开机时，以管理员身份只做一件事：启动"安装器"（负责经过批准的安装）。
# 其余的一切 —— 桌面、浏览器、Bot 的工具服务 —— 都降到普通用户 bot 去跑，bot 没有管理员权限。
mkdir -p /var/lib/bot-installer
( while true; do node /opt/bot/installer.js >>/var/log/bot-installer.log 2>&1; sleep 3; done ) &
exec runuser -u bot -- /opt/bot/entrypoint.sh
