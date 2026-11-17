#!/bin/bash
# 在宿主机上（重新）创建 Agent 容器。数据都在 /opt/agent/{home,workspace,state}，重建容器不会丢。
set -e
cd /opt/agent
mkdir -p home workspace state
chown 1000:1000 home workspace
docker build -q -t dispatch-agent:latest build >/dev/null
docker rm -f agent >/dev/null 2>&1 || true
docker run -d --name agent --hostname agent --restart unless-stopped \
  --memory 10g --cpus 3 --pids-limit 4096 \
  -p 127.0.0.1:7681:7681 \
  -p 127.0.0.1:7683:7683 \
  -p 2222:2222 \
  -v /opt/agent/home:/home/agent \
  -v /opt/agent/workspace:/workspace \
  -v /opt/agent/workspace:/srv/sftp/workspace \
  -v /opt/agent/state:/state \
  dispatch-agent:latest >/dev/null
echo "agent container started"
