#!/usr/bin/env python3
"""
龙族共享知识库 - 双向文件共享服务器
支持：GET（下载）、POST（上传）、DELETE（删除）、LIST（列表）
基于 HTTP Basic Auth 验证
"""

import http.server
import socketserver
import urllib.parse
import os
import json
import base64
from pathlib import Path
from datetime import datetime

# ============ 配置 ============
PORT = 3001
SHARE_DIRECTORY = "/Users/zxd/ClawData/WorkBuddy/dragon-share"
USERS = {
    "zxd": "123456",        # 师父
    "longsung": "pass123",  # 龙松
    "longzhu": "pass456",   # 龙竹
    "longmei": "pass789",   # 龙梅
    "longmuxin": "wood123", # 龙木心
    "longhuoer": "fire456", # 龙火儿
    "longtudou": "earth789",# 龙土豆
    "longjinbao": "gold111",# 龙金宝
    "longshui": "water222"  # 龙水珠
}

# ============ 初始化共享目录 ============
def init_share_directory():
    Path(SHARE_DIRECTORY).mkdir(parents=True, exist_ok=True)
    categories = ["memory", "skills", "resources", "logs"]
    for category in categories:
        Path(SHARE_DIRECTORY, category).mkdir(exist_ok=True)

# ============ 认证 ============
class AuthHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def do_AUTHHEAD(self):
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="Dragon Knowledge Hub"')
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Unauthorized"}).encode())

    def check_auth(self):
        """验证用户身份，返回 (is_valid, username)"""
        auth_header = self.headers.get('Authorization')
        if auth_header is None:
            return False, None
        
        try:
            auth_type, auth_data = auth_header.split(' ', 1)
            if auth_type.lower() != 'basic':
                return False, None
            
            decoded = base64.b64decode(auth_data).decode('utf-8')
            username, password = decoded.split(':', 1)
            
            if username in USERS and USERS[username] == password:
                return True, username
            return False, None
        except:
            return False, None

    def log_action(self, username, action, path, status):
        """记录操作日志"""
        log_file = Path(SHARE_DIRECTORY) / "logs" / "access.log"
        timestamp = datetime.now().isoformat()
        log_entry = f"[{timestamp}] {username} | {action} | {path} | {status}\n"
        with open(log_file, 'a') as f:
            f.write(log_entry)

    def do_GET(self):
        """下载文件或获取目录列表"""
        is_valid, username = self.check_auth()
        if not is_valid:
            self.do_AUTHHEAD()
            return

        path = urllib.parse.unquote(self.path).lstrip('/')
        full_path = Path(SHARE_DIRECTORY) / path
        
        # 安全检查：防止目录遍历
        try:
            full_path = full_path.resolve()
            if not str(full_path).startswith(str(Path(SHARE_DIRECTORY).resolve())):
                self.send_error(403)
                return
        except:
            self.send_error(400)
            return

        # 列表请求
        if path.endswith('/') or (full_path.exists() and full_path.is_dir()):
            self.handle_list_directory(username, full_path, path)
            return

        # 文件下载
        if full_path.exists() and full_path.is_file():
            try:
                with open(full_path, 'rb') as f:
                    self.send_response(200)
                    self.send_header('Content-type', 'application/octet-stream')
                    self.send_header('Content-Disposition', f'attachment; filename="{full_path.name}"')
                    self.end_headers()
                    self.wfile.write(f.read())
                    self.log_action(username, "DOWNLOAD", path, "200")
            except Exception as e:
                self.send_error(500)
                self.log_action(username, "DOWNLOAD", path, f"500: {str(e)}")
        else:
            self.send_error(404)
            self.log_action(username, "DOWNLOAD", path, "404")

    def handle_list_directory(self, username, full_path, path):
        """返回目录列表（JSON 格式）"""
        try:
            items = []
            for item in sorted(full_path.iterdir()):
                item_path = item.relative_to(Path(SHARE_DIRECTORY))
                is_dir = item.is_dir()
                size = item.stat().st_size if item.is_file() else 0
                mtime = datetime.fromtimestamp(item.stat().st_mtime).isoformat()
                
                items.append({
                    "name": item.name,
                    "path": str(item_path),
                    "type": "directory" if is_dir else "file",
                    "size": size,
                    "modified": mtime
                })
            
            response = {
                "path": path or "/",
                "items": items
            }
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response, indent=2).encode())
            self.log_action(username, "LIST", path, "200")
        except Exception as e:
            self.send_error(500)
            self.log_action(username, "LIST", path, f"500: {str(e)}")

    def do_POST(self):
        """上传文件"""
        is_valid, username = self.check_auth()
        if not is_valid:
            self.do_AUTHHEAD()
            return

        try:
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length == 0:
                self.send_error(400, "No file content")
                return

            path = urllib.parse.unquote(self.path).lstrip('/')
            full_path = Path(SHARE_DIRECTORY) / path
            
            # 安全检查
            try:
                full_path = full_path.resolve()
                if not str(full_path).startswith(str(Path(SHARE_DIRECTORY).resolve())):
                    self.send_error(403)
                    return
            except:
                self.send_error(400)
                return

            # 创建目录
            full_path.parent.mkdir(parents=True, exist_ok=True)

            # 保存文件
            content = self.rfile.read(content_length)
            with open(full_path, 'wb') as f:
                f.write(content)

            response = {
                "status": "success",
                "message": f"File uploaded: {path}",
                "path": path,
                "size": len(content),
                "user": username,
                "timestamp": datetime.now().isoformat()
            }

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            self.log_action(username, "UPLOAD", path, "200")

        except Exception as e:
            self.send_error(500)
            self.log_action(username, "UPLOAD", path, f"500: {str(e)}")

    def do_DELETE(self):
        """删除文件"""
        is_valid, username = self.check_auth()
        if not is_valid:
            self.do_AUTHHEAD()
            return

        path = urllib.parse.unquote(self.path).lstrip('/')
        full_path = Path(SHARE_DIRECTORY) / path
        
        # 安全检查
        try:
            full_path = full_path.resolve()
            if not str(full_path).startswith(str(Path(SHARE_DIRECTORY).resolve())):
                self.send_error(403)
                return
        except:
            self.send_error(400)
            return

        try:
            if full_path.exists():
                if full_path.is_file():
                    full_path.unlink()
                    response = {"status": "success", "message": f"File deleted: {path}"}
                else:
                    response = {"status": "error", "message": "Cannot delete directory"}
                    self.send_error(400)
                    return
            else:
                response = {"status": "error", "message": "File not found"}
                self.send_error(404)
                return

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            self.log_action(username, "DELETE", path, "200")

        except Exception as e:
            self.send_error(500)
            self.log_action(username, "DELETE", path, f"500: {str(e)}")

def main():
    init_share_directory()
    
    handler = AuthHTTPHandler
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print("=" * 60)
        print("🐉 龙族共享知识库 - 双向文件共享服务器")
        print("=" * 60)
        print(f"📍 本地地址：http://localhost:{PORT}")
        print(f"📁 共享目录：{SHARE_DIRECTORY}")
        print(f"👥 已注册用户：{len(USERS)} 人")
        print(f"✅ 功能：GET（下载）、POST（上传）、DELETE（删除）、LIST（列表）")
        print("=" * 60)
        print("⏸️  按 Ctrl+C 停止服务器\n")
        httpd.serve_forever()

if __name__ == "__main__":
    main()
