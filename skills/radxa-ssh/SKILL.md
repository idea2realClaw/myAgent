---
name: radxa-ssh
description: Radxa Dragon Q6A 远程操作 Skill。通过 Tailscale 网络远程连接并操作 Radxa 设备，支持系统信息查看、Docker 安装与管理、文件传输等操作。触发场景：连接 Radxa、远程操作 Radxa、安装 Docker、Radxa SSH、radxa-dragon-q6a。
---

# Radxa SSH Skill v1（2026-04-18）

## 设备信息

| 项目 | 信息 |
|------|------|
| **设备名** | radxa-dragon-q6a |
| **Tailscale IP** | 100.92.193.86 |
| **SSH 用户** | radxa |
| **SSH 密码** | radxa |
| **系统** | Linux aarch64 |

## 前置条件

### macOS 必须安装 sshpass

```bash
brew install sshpass
```

## 快速连接

### 连接设备

```bash
sshpass -p 'radxa' ssh radxa@100.92.193.86
```

### 执行单条命令

```bash
sshpass -p 'radxa' ssh radxa@100.92.193.86 '<命令>'
```

### sudo 执行（密码自动传递）

```bash
echo 'radxa' | sshpass -p 'radxa' ssh -T radxa@100.92.193.86 'sudo -S <命令>'
```

## 常用操作

### 系统信息

```bash
# 基本信息
sshpass -p 'radxa' ssh radxa@100.92.193.86 'hostname && uptime && df -h && free -h'

# CPU 信息
sshpass -p 'radxa' ssh radxa@100.92.193.86 'lscpu | grep -E "(Model name|CPU|Architecture)"'

# 网络状态
sshpass -p 'radxa' ssh radxa@100.92.193.86 'ip addr show | grep inet'
```

### Tailscale 状态

```bash
sshpass -p 'radxa' ssh radxa@100.92.193.86 'tailscale status'
```

### Docker 操作

```bash
# 查看 Docker 版本
sshpass -p 'radxa' ssh radxa@100.92.193.86 'docker --version'

# 查看运行中的容器
sshpass -p 'radxa' ssh radxa@100.92.193.86 'sudo docker ps'

# 查看所有容器
sshpass -p 'radxa' ssh radxa@100.92.193.86 'sudo docker ps -a'

# 查看镜像
sshpass -p 'radxa' ssh radxa@100.92.193.86 'sudo docker images'

# 运行 hello-world
echo 'radxa' | sshpass -p 'radxa' ssh -T radxa@100.92.193.86 'sudo -S docker run hello-world'

# 拉取镜像
echo 'radxa' | sshpass -p 'radxa' ssh -T radxa@100.92.193.86 'sudo -S docker pull ubuntu'
```

## Docker 安装（首次）

如果设备上没有 Docker，执行以下命令安装：

```bash
# 登录到设备
sshpass -p 'radxa' ssh radxa@100.92.193.86

# 在设备上执行
curl -fsSL https://get.docker.com | sh

# 退出后配置当前用户（可选）
echo 'radxa' | sshpass -p 'radxa' ssh -T radxa@100.92.193.86 'sudo -S usermod -aG docker radxa'
```

**注意**：由于 sudo 密码交互问题，建议使用 `echo 'password' | sudo -S command` 方式执行 Docker 命令。

## 文件传输

### 从 Mac 传到 Radxa

```bash
sshpass -p 'radxa' scp ~/local/file.txt radxa@100.92.193.86:/home/radxa/
```

### 从 Radxa 传到 Mac

```bash
sshpass -p 'radxa' scp radxa@100.92.193.86:/home/radxa/file.txt ~/Downloads/
```

## 经验总结（2026-04-18）

### SSH 连接要点

| 问题 | 解决方案 |
|------|----------|
| Mac 默认没有 sshpass | `brew install sshpass` |
| sudo 密码交互失败 | `echo 'password' \| sudo -S command` |
| Tailscale SSH 不可用 | 使用标准 SSH + sshpass |
| Host key 检查失败 | 添加 `-o StrictHostKeyChecking=no` |

### Radxa 硬件配置

- CPU: 8核 ARM (4×A55 2.0GHz + 4×A78 2.7GHz)
- 内存: 11 GB
- 存储: 116 GB SSD
- 架构: aarch64 (ARM64)

### Docker 镜像选择

Radxa 使用 ARM64 (aarch64) 架构，需要拉取 **arm64v8** 镜像：

```bash
# 正确
sudo docker run arm64v8/ubuntu

# 错误（x86 镜像无法运行）
sudo docker run ubuntu
```

## 使用脚本

也可以使用附带的脚本简化操作：

```bash
# 连接设备
python3 ~/.workbuddy/skills/radxa-ssh/scripts/connect.py

# 执行命令
python3 ~/.workbuddy/skills/radxa-ssh/scripts/connect.py "docker ps"

# 查看系统信息
python3 ~/.workbuddy/skills/radxa-ssh/scripts/connect.py "sysinfo"
```

## 故障排除

### 连接失败

```bash
# 检查 Tailscale 是否在线
/Applications/Tailscale.app/Contents/MacOS/Tailscale status

# 检查网络连通性
ping 100.92.193.86
```

### Docker 权限问题

```bash
# 使用 sudo 执行
echo 'radxa' | sshpass -p 'radxa' ssh -T radxa@100.92.193.86 'sudo -S docker ps'
```
