#!/usr/bin/env python3
"""
龙族知识同步工具
用法：
  python3 dragon_sync.py upload <本地文件/目录> <远程路径> [选项]
  python3 dragon_sync.py download <远程路径> <本地目标目录> [选项]
  python3 dragon_sync.py list [远程路径] [选项]
  python3 dragon_sync.py share-memory  [选项]   # 快速共享当前 Memory.md
  python3 dragon_sync.py share-skill <技能名>    # 快速共享某个 Skill 目录
  python3 dragon_sync.py sync-memory            # 从共享库同步最新 Memory.md
  python3 dragon_sync.py sync-skills            # 从共享库同步所有技能

通用选项：
  --server  SERVER_URL   服务器地址（默认从 ~/.workbuddy/dragon_hub.conf 读取）
  --user    USERNAME     用户名（默认从 conf 读取）
  --pass    PASSWORD     密码（默认从 conf 读取）
"""

import os
import sys
import json
import base64
import argparse
import zipfile
import shutil
import tempfile
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, quote

# ============ 默认配置 ============
DEFAULT_CONF_PATH = Path.home() / ".workbuddy" / "dragon_hub.conf"
DEFAULT_CONF = {
    "server": "http://localhost:3001",
    "username": "",
    "password": ""
}

# 路径映射（快捷命令用）
# 优先查找当前工作空间的 MEMORY.md，其次查找 ~/.workbuddy/
def _find_memory_path():
    """查找 MEMORY.md，支持多个工作空间"""
    candidates = [
        Path.cwd() / ".workbuddy" / "memory" / "MEMORY.md",       # 当前工作空间
        Path.home() / ".workbuddy" / "memory" / "MEMORY.md",     # 用户全局
        Path.home() / ".workbuddy" / "MEMORY.md",                 # 用户根目录
    ]
    for p in candidates:
        if p.exists():
            return p
    return candidates[0]  # 返回默认路径，即使不存在

MEMORY_LOCAL_PATH   = _find_memory_path()
SKILLS_LOCAL_PATH   = Path.home() / ".workbuddy" / "skills"
MEMORY_REMOTE_PATH  = "memory"
SKILLS_REMOTE_PATH  = "skills"

# ============ 配置管理 ============
def load_conf():
    if DEFAULT_CONF_PATH.exists():
        with open(DEFAULT_CONF_PATH, 'r') as f:
            return json.load(f)
    return DEFAULT_CONF.copy()

def save_conf(conf):
    DEFAULT_CONF_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(DEFAULT_CONF_PATH, 'w') as f:
        json.dump(conf, f, indent=2)
    print(f"✅ 配置已保存到：{DEFAULT_CONF_PATH}")

def make_auth_header(username, password):
    credentials = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": f"Basic {credentials}"}

# ============ HTTP 工具 ============
def do_request(method, server, path, auth_headers, data=None, timeout=30):
    url = urljoin(server.rstrip('/') + '/', quote(path.lstrip('/'), safe='/'))
    headers = {**auth_headers}
    if data:
        headers['Content-Length'] = str(len(data))

    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except HTTPError as e:
        return e.code, e.read()
    except URLError as e:
        return 0, str(e).encode()

# ============ 核心操作 ============
def cmd_list(server, path, auth_headers):
    """列出远程目录"""
    remote_path = path.rstrip('/') + '/'
    status, body = do_request('GET', server, remote_path, auth_headers)
    if status == 200:
        try:
            data = json.loads(body)
            items = data.get('items', [])
            print(f"\n📁 远程路径：/{data['path']}")
            print("-" * 50)
            if not items:
                print("  （空目录）")
            for item in items:
                icon = "📂" if item['type'] == 'directory' else "📄"
                size_str = f"  {item['size']} bytes" if item['type'] == 'file' else ""
                mtime = item['modified'][:10]
                print(f"  {icon} {item['name']:<30} [{mtime}]{size_str}")
            print()
        except json.JSONDecodeError:
            print(body.decode())
    else:
        print(f"❌ 列表失败：HTTP {status}")
        print(body.decode())

def cmd_upload_file(server, local_path, remote_path, auth_headers):
    """上传单个文件"""
    local = Path(local_path)
    if not local.exists() or not local.is_file():
        print(f"❌ 本地文件不存在：{local_path}")
        return False

    with open(local, 'rb') as f:
        data = f.read()
    
    status, body = do_request('POST', server, remote_path, auth_headers, data=data)
    if status == 200:
        resp = json.loads(body)
        size_kb = resp.get('size', 0) / 1024
        print(f"  ✅ 上传：{local.name} → /{remote_path}  ({size_kb:.1f} KB)")
        return True
    else:
        print(f"  ❌ 上传失败：{local.name}  HTTP {status}")
        print(f"     {body.decode()}")
        return False

def cmd_upload_directory(server, local_dir, remote_dir, auth_headers):
    """上传整个目录（打包为 zip）"""
    local = Path(local_dir)
    if not local.exists() or not local.is_dir():
        print(f"❌ 本地目录不存在：{local_dir}")
        return False

    dir_name = local.name
    zip_remote = f"{remote_dir.rstrip('/')}/{dir_name}.zip"

    with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp:
        tmp_path = tmp.name

    try:
        print(f"  📦 打包目录：{local.name} ...")
        with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for file_path in local.rglob('*'):
                if file_path.is_file():
                    arcname = file_path.relative_to(local.parent)
                    zf.write(file_path, arcname)

        return cmd_upload_file(server, tmp_path, zip_remote, auth_headers)
    finally:
        os.unlink(tmp_path)

def cmd_download_file(server, remote_path, local_dir, auth_headers):
    """下载单个文件"""
    status, body = do_request('GET', server, remote_path, auth_headers)
    if status == 200:
        filename = Path(remote_path).name
        local_target = Path(local_dir) / filename
        Path(local_dir).mkdir(parents=True, exist_ok=True)
        with open(local_target, 'wb') as f:
            f.write(body)
        print(f"  ✅ 下载：/{remote_path} → {local_target}")
        
        # 如果是 zip，询问是否解压
        if filename.endswith('.zip'):
            extract_dir = Path(local_dir) / filename[:-4]
            print(f"  📦 解压 zip 到：{extract_dir} ...")
            with zipfile.ZipFile(local_target, 'r') as zf:
                zf.extractall(Path(local_dir))
            os.unlink(local_target)
            print(f"  ✅ 解压完成：{extract_dir}")
        return True
    else:
        print(f"  ❌ 下载失败：/{remote_path}  HTTP {status}")
        return False

# ============ 快捷命令 ============
def cmd_share_memory(server, auth_headers):
    """快速共享 MEMORY.md"""
    if not MEMORY_LOCAL_PATH.exists():
        print(f"❌ 找不到 MEMORY.md：{MEMORY_LOCAL_PATH}")
        return
    
    username = list(auth_headers.values())[0].split(' ')[1]
    username = base64.b64decode(username).decode().split(':')[0]
    remote_path = f"{MEMORY_REMOTE_PATH}/{username}_MEMORY.md"

    print(f"📤 正在共享 MEMORY.md ...")
    cmd_upload_file(server, str(MEMORY_LOCAL_PATH), remote_path, auth_headers)

def cmd_share_skill(server, skill_name, auth_headers):
    """快速共享某个 Skill 目录"""
    skill_path = SKILLS_LOCAL_PATH / skill_name
    if not skill_path.exists():
        print(f"❌ 找不到 Skill：{skill_path}")
        print(f"   可用的 Skills：")
        for s in SKILLS_LOCAL_PATH.iterdir():
            if s.is_dir() and not s.name.startswith('.'):
                print(f"   - {s.name}")
        return
    
    print(f"📤 正在共享 Skill：{skill_name} ...")
    cmd_upload_directory(server, str(skill_path), SKILLS_REMOTE_PATH, auth_headers)

def cmd_sync_memory(server, auth_headers):
    """从共享库查看所有成员的 MEMORY.md"""
    print("📥 获取成员共享的 Memory 列表 ...")
    status, body = do_request('GET', server, MEMORY_REMOTE_PATH + '/', auth_headers)
    if status == 200:
        data = json.loads(body)
        items = [i for i in data['items'] if i['name'].endswith('_MEMORY.md')]
        if not items:
            print("  （暂无成员共享 Memory）")
            return
        
        target_dir = Path.home() / ".workbuddy" / "dragon-shared" / "memory"
        for item in items:
            cmd_download_file(server, item['path'], str(target_dir), auth_headers)
        print(f"\n✅ 所有 Memory 文件已下载到：{target_dir}")
    else:
        print(f"❌ 获取失败：HTTP {status}")

def cmd_sync_skills(server, auth_headers):
    """从共享库下载所有 Skill（zip）"""
    print("📥 获取共享的 Skills 列表 ...")
    status, body = do_request('GET', server, SKILLS_REMOTE_PATH + '/', auth_headers)
    if status == 200:
        data = json.loads(body)
        items = [i for i in data['items'] if i['name'].endswith('.zip')]
        if not items:
            print("  （暂无共享 Skill）")
            return
        
        print(f"  找到 {len(items)} 个共享 Skill：")
        for item in items:
            print(f"  - {item['name'][:-4]}")
        
        confirm = input("\n是否全部下载到本地 Skills 目录？(y/N) ")
        if confirm.lower() != 'y':
            return
        
        for item in items:
            cmd_download_file(server, item['path'], str(SKILLS_LOCAL_PATH), auth_headers)
        print(f"\n✅ Skills 已同步到：{SKILLS_LOCAL_PATH}")
    else:
        print(f"❌ 获取失败：HTTP {status}")

# ============ 主程序 ============
def main():
    parser = argparse.ArgumentParser(description='龙族知识同步工具')
    parser.add_argument('command', choices=['upload', 'download', 'list',
                                             'share-memory', 'share-skill',
                                             'sync-memory', 'sync-skills', 'config'])
    parser.add_argument('args', nargs='*', help='命令参数')
    parser.add_argument('--server',  help='服务器地址')
    parser.add_argument('--user',    help='用户名')
    parser.add_argument('--pass',    dest='password', help='密码')
    args = parser.parse_args()

    conf = load_conf()
    server   = args.server   or conf.get('server',   DEFAULT_CONF['server'])
    username = args.user     or conf.get('username', '')
    password = args.password or conf.get('password', '')

    # 配置命令
    if args.command == 'config':
        if len(args.args) >= 2 and args.args[0] == 'set':
            key, value = args.args[1], ' '.join(args.args[2:])
            conf[key] = value
            save_conf(conf)
        else:
            print("当前配置：")
            for k, v in conf.items():
                display_v = '*' * len(v) if k == 'password' else v
                print(f"  {k}: {display_v}")
        return

    if not username or not password:
        print("❌ 未配置用户名/密码，请先运行：")
        print("   python3 dragon_sync.py config set username <你的用户名>")
        print("   python3 dragon_sync.py config set password <你的密码>")
        print("   python3 dragon_sync.py config set server   <服务器地址>")
        sys.exit(1)

    auth_headers = make_auth_header(username, password)

    if args.command == 'list':
        path = args.args[0] if args.args else ''
        cmd_list(server, path, auth_headers)

    elif args.command == 'upload':
        if len(args.args) < 2:
            print("用法：upload <本地文件/目录> <远程路径>")
            sys.exit(1)
        local, remote = args.args[0], args.args[1]
        if Path(local).is_dir():
            cmd_upload_directory(server, local, remote, auth_headers)
        else:
            cmd_upload_file(server, local, remote, auth_headers)

    elif args.command == 'download':
        if len(args.args) < 2:
            print("用法：download <远程路径> <本地目标目录>")
            sys.exit(1)
        remote, local = args.args[0], args.args[1]
        cmd_download_file(server, remote, local, auth_headers)

    elif args.command == 'share-memory':
        cmd_share_memory(server, auth_headers)

    elif args.command == 'share-skill':
        if not args.args:
            print("用法：share-skill <技能名>")
            print("例如：share-skill ftp-setup")
            sys.exit(1)
        cmd_share_skill(server, args.args[0], auth_headers)

    elif args.command == 'sync-memory':
        cmd_sync_memory(server, auth_headers)

    elif args.command == 'sync-skills':
        cmd_sync_skills(server, auth_headers)

if __name__ == "__main__":
    main()
