#!/bin/bash
# 只读采集本机的配置和指标，输出 key=value。调度台在本机直接运行它；
# 在其他服务器上它被装成 /usr/local/bin/dispatch-collect，由受限 SSH 密钥触发。
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin
echo "host=$(hostname)"
. /etc/os-release 2>/dev/null; echo "os=$PRETTY_NAME"
echo "kernel=$(uname -r)"
echo "arch=$(uname -m)"
echo "cpu=$(awk -F: '/model name/{print $2;exit}' /proc/cpuinfo | sed 's/^ *//')"
echo "cores=$(nproc)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
awk '/^MemTotal/{print "memTotalKb="$2}/^MemAvailable/{print "memAvailKb="$2}/^SwapTotal/{print "swapTotalKb="$2}/^SwapFree/{print "swapFreeKb="$2}' /proc/meminfo
echo "uptimeSec=$(cut -d. -f1 /proc/uptime)"
echo "virt=$(systemd-detect-virt 2>/dev/null)"
echo "procs=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)"
df -PT -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null | awk 'NR>1{print "disk="$7"|"$2"|"$3"|"$4"|"$6}'
