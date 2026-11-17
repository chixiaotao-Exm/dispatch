#!/bin/bash
# 设置专用 Agent 的 SFTP 密码。在 Agent 所在的服务器上以 root 运行。
# 这个端口对公网开放，所以要求密码至少 12 位。服务器上只保存密码的哈希，不保存明文。
set -e
umask 077
echo "请为 SFTP（用户名 files，端口 2222）设置密码。至少 12 位，输入时不显示。"
while true; do
  read -r -s -p "SFTP 密码: " p1; echo
  if [ "${#p1}" -lt 12 ]; then echo "太短了，至少 12 位，请重新输入。"; continue; fi
  read -r -s -p "再输一次: " p2; echo
  if [ "$p1" != "$p2" ]; then echo "两次不一致，请重新输入。"; continue; fi
  break
done
# 在容器里设置密码，再把哈希存到持久目录，容器重建后自动恢复。
printf 'files:%s\n' "$p1" | docker exec -i agent chpasswd
docker exec agent bash -c "getent shadow files | cut -d: -f2 > /state/sftp.hash && chmod 600 /state/sftp.hash"
echo "SFTP-PASSWORD-SET"
