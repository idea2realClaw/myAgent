#!/usr/bin/env python3
"""
Radxa SSH 连接脚本
用于通过 Tailscale 远程连接并操作 Radxa Dragon Q6A 设备
"""

import subprocess
import sys
import os

# 设备配置
DEVICE_IP = "100.92.193.86"
DEVICE_USER = "radxa"
DEVICE_PASS = "radxa"

def run_ssh(command):
    """执行 SSH 命令"""
    if not command:
        # 无命令参数，建立交互式连接
        cmd = ["sshpass", "-p", DEVICE_PASS, "ssh", f"{DEVICE_USER}@{DEVICE_IP}"]
    else:
        cmd = ["sshpass", "-p", DEVICE_PASS, "ssh", f"{DEVICE_USER}@{DEVICE_IP}", command]

    result = subprocess.run(cmd, capture_output=False)
    return result.returncode

def show_sysinfo():
    """显示系统信息"""
    command = """
echo '=== Radxa Dragon Q6A 系统信息 ==='
echo ''
echo '【主机名】'
hostname
echo ''
echo '【运行时间】'
uptime
echo ''
echo '【CPU 信息】'
lscpu | grep -E '(Model name|CPU\(s\)|Architecture|CPU max)'
echo ''
echo '【内存】'
free -h
echo ''
echo '【磁盘】'
df -h | grep -E '(Filesystem|/dev/)'
echo ''
echo '【网络】'
ip addr show | grep inet
echo ''
echo '【Docker 版本】'
docker --version 2>/dev/null || echo 'Docker 未安装'
echo ''
echo '【运行中的容器】'
sudo docker ps 2>/dev/null || echo '无运行中的容器'
"""
    return run_ssh(command)

def main():
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if arg == "sysinfo":
            return show_sysinfo()
        else:
            return run_ssh(arg)
    else:
        print(f"连接到 Radxa Dragon Q6A ({DEVICE_IP})...")
        print("输入 exit 退出连接")
        print("-" * 40)
        return run_ssh(None)

if __name__ == "__main__":
    sys.exit(main())
