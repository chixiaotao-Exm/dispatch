#!/bin/bash
# 启动（或重建）Bot 发布站的两个容器。
#   pub-files：只读文件服务。无任何权限、文件系统只读、只监听本机 7699；只看得到两个 public 文件夹。
#   pub-caddy：证书 + 转发。用宿主机网络，这样防火墙规则（只放行 Cloudflare）对它生效。
set -e
mkdir -p /opt/pub/caddy-data /opt/pub/caddy-config
# 两个 public 文件夹归各自容器里的用户所有（它们往里放东西）
for d in /opt/agent/workspace /opt/bots/home; do [ -d $d/public ] || install -d -m 755 -o "$(stat -c %u $d)" -g "$(stat -c %g $d)" $d/public; done

docker rm -f pub-files 2>/dev/null || true
docker run -d --name pub-files --restart unless-stopped \
  --user 65534:65534 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --cpus 1 --pids-limit 100 \
  -p 127.0.0.1:7699:7699 \
  -v /opt/pub/pub-server.js:/pub-server.js:ro \
  -v /opt/agent/workspace/public:/srv/a:ro \
  -v /opt/bots/home/public:/srv/b:ro \
  --entrypoint node dispatch-agent:latest /pub-server.js

docker rm -f pub-caddy 2>/dev/null || true
docker run -d --name pub-caddy --restart unless-stopped --network host \
  --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
  --memory 256m --cpus 1 \
  -v /opt/pub/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /opt/pub/caddy-data:/data -v /opt/pub/caddy-config:/config \
  caddy:2
