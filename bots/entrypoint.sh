#!/bin/bash
# 启动 Bot 电脑里的各个部件：虚拟屏幕、窗口管理、远程查看、浏览器、工具服务。
export DISPLAY=:1 HOME=/home/bot
mkdir -p "$HOME/work" "$HOME/Desktop" "$HOME/.config/openbox"
cd "$HOME"
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
# 上次没有正常退出时，浏览器会弹"恢复页面"；把退出状态改成正常，免得挡住画面。
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$HOME/.chromium/Default/Preferences" 2>/dev/null || true
# 画图时默认用中文字体，免得中文变成方块。
mkdir -p "$HOME/.config/matplotlib"
printf 'font.family: sans-serif
font.sans-serif: Noto Sans CJK JP, Noto Sans CJK SC, DejaVu Sans
axes.unicode_minus: False
' > "$HOME/.config/matplotlib/matplotlibrc"

keep() { # 某个部件退出了就自动再拉起来
  local name=$1; shift
  ( while true; do "$@" >>"/tmp/$name.log" 2>&1; sleep 2; done ) &
}

keep xvfb Xvfb :1 -screen 0 1440x900x24 -nolisten tcp
for i in $(seq 1 50); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.2; done
xsetroot -solid "#1b2233"
xset b off   # 关掉这台电脑的响铃，免得传到正在看远程桌面的人那里
keep openbox openbox
keep tint2 tint2
keep x11vnc x11vnc -display :1 -forever -shared -nopw -rfbport 5900 -localhost -quiet -noxdamage -nobell
keep novnc websockify --web /usr/share/novnc 6080 localhost:5900
# 浏览器：开着调试端口，工具服务通过它来操作；用户在远程桌面里看到的就是这个窗口。
# 容器本身就是隔离边界，所以关掉了浏览器自带的沙箱（它在容器里起不来）。
keep chromium chromium --no-sandbox --test-type --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$HOME/.chromium" \
  --window-size=1180,820 --window-position=130,20 --lang=zh-CN --password-store=basic \
  --disable-features=Translate,MediaRouter --disable-background-networking \
  --disable-session-crashed-bubble --hide-crash-restore-bubble --disable-infobars about:blank

exec node /opt/bot/bot-tools.js
