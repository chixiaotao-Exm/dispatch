#!/bin/bash
# 启动（或重建）Bot 的电脑。端口只映射到本机回环地址，外网访问不到；调度台通过加密隧道来用。
docker rm -f bots 2>/dev/null
# Bot 的电脑用自己单独的网络：这样它连不到同一台机器上的其他容器（比如专用 Agent 的内部服务），只能上外网。
docker network inspect botnet >/dev/null 2>&1 || docker network create botnet >/dev/null
docker run -d --name bots --restart unless-stopped --hostname bot-pc --network botnet \
  --memory 6g --cpus 3 --shm-size 1g --pids-limit 2000 \
  -p 127.0.0.1:7695:7695 -p 127.0.0.1:6080:6080 \
  -v /opt/bots/home:/home/bot -v /opt/bots/state:/var/lib/bot-installer \
  bots:latest
