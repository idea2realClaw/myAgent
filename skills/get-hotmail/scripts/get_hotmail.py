#!/usr/bin/env python3
"""
GetHotmail 邮件工具 - 专用于 tuishoudao@hotmail.com（Outlook OAuth2 认证）
用法：
  python3 get_hotmail.py inbox   [数量]          # 查看收件箱（默认10封）
  python3 get_hotmail.py read    <邮件ID>         # 阅读邮件正文
  python3 get_hotmail.py search  <关键词> [数量]  # 搜索邮件
  python3 get_hotmail.py config                   # 查看/设置配置

首次使用会显示设备码，在浏览器中登录并输入代码完成授权后会保存 refresh_token。
"""

import os
import sys
import json
import imaplib
import email
import time
from email.header import decode_header
from email.utils import parsedate_to_datetime
from pathlib import Path

# 尝试导入 msal，未安装则提示
try:
    import msal
except ImportError:
    print("❌ 缺少依赖：msal")
    print("   请安装：pip3 install msal")
    sys.exit(1)


# ============ 固定账号 ============
ACCOUNT_EMAIL = "tuishoudao@hotmail.com"
CONF_PATH = Path.home() / ".workbuddy" / "hotmail.conf"
IMAP_SERVER = "imap-mail.outlook.com"
IMAP_PORT = 993

# 微软 OAuth2 配置（公共客户端，无需自己注册应用）
CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c"  # Azure PowerShell 客户端
TENANT_ID = "common"  # 通用租户
AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
SCOPE = ["https://outlook.office.com/.default"]


# ============ 配置管理 ============
def load_conf():
    if CONF_PATH.exists():
        with open(CONF_PATH, "r") as f:
            return json.load(f)
    return {}


def save_conf(conf):
    CONF_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONF_PATH, "w") as f:
        json.dump(conf, f, indent=2, ensure_ascii=False)
    os.chmod(CONF_PATH, 0o600)


# ============ OAuth2 认证（设备码流） ============
def get_access_token():
    """获取 IMAP 访问令牌（优先用 refresh_token 刷新，否则显示设备码让用户授权）"""
    conf = load_conf()

    # 创建 MSAL 应用实例
    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY)

    # 1. 尝试用 refresh_token 刷新（已有授权）
    refresh_token = conf.get("refresh_token")
    if refresh_token:
        result = app.acquire_token_by_refresh_token(refresh_token, SCOPE)
        if "access_token" in result:
            # 刷新成功，更新配置
            conf["access_token"] = result["access_token"]
            if "refresh_token" in result:
                conf["refresh_token"] = result["refresh_token"]
            save_conf(conf)
            return result["access_token"]
        else:
            print(f"⚠️  Token 刷新失败：{result.get('error_description', '未知错误')}")
            print("   需要重新授权...")

    # 2. 设备码流：显示代码让用户在浏览器中授权
    flow = app.initiate_device_flow(SCOPE)

    print("🌐 OAuth2 设备授权")
    print("=" * 60)
    print(f"  1. 在浏览器中打开：{flow['verification_uri']}")
    print(f"  2. 输入代码：{flow['user_code']}")
    print()
    print("  等待授权中...（最多 5 分钟）")

    # 轮询等待授权
    result = None
    start = time.time()
    timeout = 300  # 5分钟超时
    while time.time() - start < timeout:
        result = app.acquire_token_by_device_flow(flow)
        if "access_token" in result:
            print("\n✅ 授权成功！")
            break
        elif "error" in result:
            if result["error"] == "authorization_pending":
                # 还在等待用户操作
                time.sleep(3)
            else:
                print(f"\n❌ 授权失败：{result.get('error_description', '未知错误')}")
                sys.exit(1)
        else:
            time.sleep(3)
    else:
        print("\n⏱️  授权超时，请重试")
        sys.exit(1)

    # 保存 token
    conf["access_token"] = result["access_token"]
    if "refresh_token" in result:
        conf["refresh_token"] = result["refresh_token"]
    save_conf(conf)
    return result["access_token"]


def authenticate_imap():
    """获取访问令牌并生成 IMAP SASL XOAUTH2 认证字符串"""
    token = get_access_token()
    # 生成 XOAUTH2 认证字符串
    auth_string = f"user={ACCOUNT_EMAIL}\x01auth=Bearer {token}\x01\x01"
    return auth_string


# ============ 解码工具 ============
def decode_str(s):
    if s is None:
        return ""
    parts = decode_header(s)
    result = []
    for data, charset in parts:
        if isinstance(data, bytes):
            result.append(data.decode(charset or "utf-8", errors="replace"))
        else:
            result.append(str(data))
    return "".join(result)


def format_date(date_str):
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return date_str or ""


def extract_body(msg):
    """提取邮件正文，优先纯文本，其次 HTML"""
    body_plain = ""
    body_html = ""
    for part in msg.walk():
        content_type = part.get_content_type()
        disposition = str(part.get("Content-Disposition", ""))
        if "attachment" in disposition:
            continue
        if content_type == "text/plain" and not body_plain:
            try:
                charset = part.get_content_charset() or "utf-8"
                body_plain = part.get_payload(decode=True).decode(charset, errors="replace")
            except Exception:
                body_plain = str(part.get_payload())
        elif content_type == "text/html" and not body_html:
            try:
                charset = part.get_content_charset() or "utf-8"
                body_html = part.get_payload(decode=True).decode(charset, errors="replace")
            except Exception:
                body_html = str(part.get_payload())
    return body_plain or body_html


def list_attachments(msg):
    names = []
    for part in msg.walk():
        disposition = str(part.get("Content-Disposition", ""))
        if "attachment" in disposition:
            filename = decode_str(part.get_filename() or "unnamed")
            names.append(filename)
    return names


# ============ 命令：收件箱 ============
def cmd_inbox(conf, count=10):
    auth_string = authenticate_imap()
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.authenticate("XOAUTH2", lambda x: auth_string)
            conn.select("INBOX")
            status, messages = conn.search(None, "ALL")
            ids = messages[0].split()
            total = len(ids)
            recent_ids = ids[-count:] if total > count else ids
            recent_ids = list(reversed(recent_ids))

            print(f"\n📧  {ACCOUNT_EMAIL} 收件箱")
            print(f"    最新 {len(recent_ids)} 封 / 共 {total} 封")
            print("=" * 72)

            for eid in recent_ids:
                _, data = conn.fetch(eid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
                raw = data[0][1]
                m = email.message_from_bytes(raw)
                subject = decode_str(m.get("Subject", "（无主题）"))
                sender = decode_str(m.get("From", ""))
                date = format_date(m.get("Date", ""))
                eid_str = eid.decode()
                display_sub = subject[:46] + "…" if len(subject) > 48 else subject
                display_from = sender[:32] + "…" if len(sender) > 34 else sender
                print(f"  [{eid_str:>5}]  {date}  {display_from}")
                print(f"           {display_sub}")
                print()

    except imaplib.IMAP4.error as e:
        print(f"❌ 登录失败：{e}")
        print("   可能需要重新授权：删除 ~/.workbuddy/hotmail.conf 后重试")
    except Exception as e:
        print(f"❌ 错误：{e}")


# ============ 命令：阅读邮件 ============
def cmd_read(conf, mail_id):
    auth_string = authenticate_imap()
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.authenticate("XOAUTH2", lambda x: auth_string)
            conn.select("INBOX")
            _, data = conn.fetch(mail_id, "(RFC822)")
            if not data or not data[0]:
                print(f"❌ 找不到邮件 ID：{mail_id}")
                return
            raw = data[0][1]
            msg = email.message_from_bytes(raw)

            print("=" * 72)
            print("📬  邮件详情")
            print("=" * 72)
            print(f"  发件人：{decode_str(msg.get('From', ''))}")
            print(f"  收件人：{decode_str(msg.get('To', ''))}")
            cc = msg.get("Cc")
            if cc:
                print(f"  抄  送：{decode_str(cc)}")
            print(f"  日  期：{format_date(msg.get('Date', ''))}")
            print(f"  主  题：{decode_str(msg.get('Subject', ''))}")
            print("-" * 72)

            body = extract_body(msg)
            if body:
                print(body[:3000])
                if len(body) > 3000:
                    print(f"\n… (正文共 {len(body)} 字符，已截断)")
            else:
                print("（正文为空）")

            attachments = list_attachments(msg)
            if attachments:
                print(f"\n📎  附件 ({len(attachments)}):")
                for a in attachments:
                    print(f"    - {a}")

            print("=" * 72)

    except Exception as e:
        print(f"❌ 读取失败：{e}")


# ============ 命令：搜索邮件 ============
def cmd_search(conf, keyword, count=10):
    auth_string = authenticate_imap()
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.authenticate("XOAUTH2", lambda x: auth_string)
            conn.select("INBOX")
            status, messages = conn.search(
                None, f'(OR SUBJECT "{keyword}" FROM "{keyword}")'
            )
            ids = messages[0].split()
            total = len(ids)

            if total == 0:
                print(f"🔍 未找到包含「{keyword}」的邮件")
                return

            recent_ids = ids[-count:] if total > count else ids
            recent_ids = list(reversed(recent_ids))

            print(f"\n🔍  搜索「{keyword}」—— 找到 {total} 封，显示最新 {len(recent_ids)} 封")
            print("=" * 72)

            for eid in recent_ids:
                _, data = conn.fetch(eid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
                raw = data[0][1]
                m = email.message_from_bytes(raw)
                subject = decode_str(m.get("Subject", "（无主题）"))
                sender = decode_str(m.get("From", ""))
                date = format_date(msg.get("Date", ""))
                eid_str = eid.decode()
                print(f"  [{eid_str:>5}]  {date}  {sender[:32]}")
                print(f"           {subject[:50]}")
                print()

    except Exception as e:
        print(f"❌ 搜索失败：{e}")


# ============ 命令：配置 ============
def cmd_config(conf):
    print("⚙️   GetHotmail 配置")
    print("=" * 50)
    print(f"  账  号：{ACCOUNT_EMAIL}（固定）")
    rt = conf.get("refresh_token")
    print(f"  授权状态：{'✅ 已授权' if rt else '⚠️  未授权'}")
    print()
    print("首次运行 `inbox` 会显示设备码")
    print("在浏览器中打开微软设备登录页，输入代码完成授权")
    print("如需重新授权，删除 ~/.workbuddy/hotmail.conf 后重试")


# ============ 主程序 ============
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]
    extra = sys.argv[2:]
    conf = load_conf()

    if cmd == "inbox":
        count = int(extra[0]) if extra else 10
        cmd_inbox(conf, count)

    elif cmd == "read":
        if not extra:
            print("用法：read <邮件ID>")
            sys.exit(1)
        cmd_read(conf, extra[0])

    elif cmd == "search":
        if not extra:
            print("用法：search <关键词> [数量]")
            sys.exit(1)
        keyword = extra[0]
        count = int(extra[1]) if len(extra) > 1 else 10
        cmd_search(conf, keyword, count)

    elif cmd == "config":
        cmd_config(conf)

    else:
        print(f"未知命令：{cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
