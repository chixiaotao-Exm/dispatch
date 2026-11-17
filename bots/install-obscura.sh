#!/bin/sh
# 安装 Obscura：轻量的无界面浏览器（会执行网页里的脚本，但没有窗口），给 Bot 快速读取网页用。
# 装两份：普通版，和带"隐身"功能的版本。固定版本号并核对文件指纹，保证每次构建拿到的是同一份。
set -e
V=v0.2.7
B=https://github.com/h4ckf0r0day/obscura/releases/download/$V
mkdir -p /opt/obscura/normal /opt/obscura/stealth
cd /tmp
curl -fsSL -o n.tgz $B/obscura-x86_64-linux.tar.gz
curl -fsSL -o s.tgz $B/obscura-x86_64-linux-stealth.tar.gz
echo "11b53d27cd743e00e196e216920e7f3f794cf378e3f1792b8d25d3beabaf9cad  n.tgz" | sha256sum -c -
echo "1d6514beacef9fe75671f4bf7a66d3a7bceef9bde39f8156d1ca4a701eb1e216  s.tgz" | sha256sum -c -
tar xzf n.tgz -C /opt/obscura/normal
tar xzf s.tgz -C /opt/obscura/stealth
rm -f n.tgz s.tgz
chmod -R a+rX /opt/obscura
# 命令行入口：obscura 是普通版；obscura-stealth 是隐身版（自动带上 --stealth）。
printf '%s\n' '#!/bin/sh' 'exec /opt/obscura/normal/obscura "$@"' > /usr/local/bin/obscura
printf '%s\n' '#!/bin/sh' 'exec /opt/obscura/stealth/obscura --stealth "$@"' > /usr/local/bin/obscura-stealth
chmod 755 /usr/local/bin/obscura /usr/local/bin/obscura-stealth
/usr/local/bin/obscura --version
