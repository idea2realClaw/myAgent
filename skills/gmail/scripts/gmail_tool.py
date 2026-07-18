#!/usr/bin/env python3
"""
Gmail 邮件工具 - 支持收发邮件
用法：
  python3 gmail_tool.py send     <收件人> [抄送] [主题] [正文文件或内容] [附件]
  python3 gmail_tool.py inbox    [数量]                    # 查看收件箱
  python3 gmail_tool.py read     <邮件ID>                 # 阅读邮件
  python3 gmail_tool.py search   <关键词> [数量]          # 搜索邮件
  python3 gmail_tool.py reply    <邮件ID> [正文文件或内容] # 回复邮件
  python3 gmail_tool.py config                            # 查看/设置配置

认证方式：
  1. 应用专用密码（App Password）- 推荐，无需 OAuth
  2. OAuth2（留作扩展）
"""

import os
import sys
import json
import imaplib
import smtplib
import email
import argparse
import getpass
import base64
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
from email.header import decode_header
from pathlib import Path
from datetime import datetime

# ============ 配置 ============
CONF_PATH = Path.home() / ".workbuddy" / "gmail.conf"
IMAP_SERVER = "imap.gmail.com"
IMAP_PORT = 993
SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 587

def load_conf():
    if CONF_PATH.exists():
        with open(CONF_PATH, 'r') as f:
            return json.load(f)
    return {}

def save_conf(conf):
    CONF_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONF_PATH, 'w') as f:
        json.dump(conf, f, indent=2, ensure_ascii=False)
    # 设置权限为仅用户可读（保护密码）
    os.chmod(CONF_PATH, 0o600)

def get_credentials(conf):
    addr = conf.get('email')
    pwd = conf.get('app_password')
    if not addr or not pwd:
        print("❌ 未配置邮箱或应用专用密码")
        print("   请先运行：python3 gmail_tool.py config")
        sys.exit(1)
    return addr, pwd

# ============ 邮件解码工具 ============
def decode_str(s):
    if s is None:
        return ""
    parts = decode_header(s)
    result = []
    for data, charset in parts:
        if isinstance(data, bytes):
            result.append(data.decode(charset or 'utf-8', errors='replace'))
        else:
            result.append(data)
    return ''.join(result)

def format_size(n):
    if n < 1024:
        return f"{n} B"
    elif n < 1024 * 1024:
        return f"{n/1024:.1f} KB"
    return f"{n/(1024*1024):.1f} MB"

def format_date(date_str):
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(date_str)
        return dt.strftime("%Y-%m-%d %H:%M")
    except:
        return date_str

# ============ 发送邮件 ============
def cmd_send(conf, to_addr, cc_addrs, subject, body, attachments):
    addr, pwd = get_credentials(conf)

    msg = MIMEMultipart()
    msg['From'] = addr
    msg['To'] = to_addr
    if cc_addrs:
        msg['Cc'] = ', '.join(cc_addrs)
    msg['Subject'] = subject
    msg['Date'] = email.utils.formatdate(localtime=True)

    # 正文
    msg.attach(MIMEText(body, 'plain', 'utf-8'))

    # 附件
    all_recipients = [to_addr] + (cc_addrs or [])
    for filepath in (attachments or []):
        path = Path(filepath)
        if not path.exists():
            print(f"⚠️  附件不存在：{filepath}")
            continue
        with open(path, 'rb') as f:
            part = MIMEApplication(f.read(), Name=path.name)
        part['Content-Disposition'] = f'attachment; filename="{path.name}"'
        msg.attach(part)
        print(f"📎 附件：{path.name} ({format_size(path.stat().st_size)})")

    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(addr, pwd)
            server.sendmail(addr, all_recipients, msg.as_string())
        print(f"✅ 邮件已发送！")
        print(f"   发件人：{addr}")
        print(f"   收件人：{to_addr}")
        if cc_addrs:
            print(f"   抄  送：{', '.join(cc_addrs)}")
        print(f"   主  题：{subject}")
    except smtplib.SMTPAuthenticationError:
        print("❌ 认证失败！请检查邮箱地址和应用专用密码是否正确")
        print("   提示：应用专用密码需要在 Google 账号安全设置中生成")
    except Exception as e:
        print(f"❌ 发送失败：{e}")

# ============ 读取收件箱 ============
def cmd_inbox(conf, count=10):
    addr, pwd = get_credentials(conf)
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.login(addr, pwd)
            conn.select('INBOX')
            status, messages = conn.search(None, 'ALL')
            ids = messages[0].split()
            total = len(ids)
            # 取最新的 N 封
            recent_ids = ids[-count:] if total > count else ids
            recent_ids = list(reversed(recent_ids))

            print(f"\n📧 收件箱（最新 {len(recent_ids)} / 共 {total} 封）")
            print("=" * 70)

            for eid in recent_ids:
                _, data = conn.fetch(eid, '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])')
                raw = data[0][1]
                msg = email.message_from_bytes(raw)
                subject = decode_str(msg.get('Subject', '（无主题）'))
                sender = decode_str(msg.get('From', ''))
                date = format_date(msg.get('Date', ''))
                eid_str = eid.decode()
                # 截断过长的主题
                display_sub = subject[:45] + '...' if len(subject) > 48 else subject
                print(f"  [{eid_str:>4}] {date}  {sender[:30]:<30}")
                print(f"         {display_sub}")
                print()

    except imaplib.IMAP4.error as e:
        print(f"❌ 登录失败：{e}")
        print("   请检查邮箱地址和应用专用密码")

# ============ 阅读邮件 ============
def cmd_read(conf, mail_id):
    addr, pwd = get_credentials(conf)
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.login(addr, pwd)
            conn.select('INBOX')
            _, data = conn.fetch(mail_id, '(RFC822)')
            if not data or not data[0]:
                print(f"❌ 找不到邮件 ID：{mail_id}")
                return
            raw = data[0][1]
            msg = email.message_from_bytes(raw)

            print("=" * 70)
            print(f"📬 邮件详情")
            print("=" * 70)
            print(f"  发件人：{decode_str(msg.get('From', ''))}")
            print(f"  收件人：{decode_str(msg.get('To', ''))}")
            cc = msg.get('Cc')
            if cc:
                print(f"  抄  送：{decode_str(cc)}")
            print(f"  日  期：{format_date(msg.get('Date', ''))}")
            print(f"  主  题：{decode_str(msg.get('Subject', ''))}")
            print("-" * 70)

            # 提取正文和附件
            body_text = ""
            attachments = []
            for part in msg.walk():
                content_type = part.get_content_type()
                disposition = str(part.get('Content-Disposition', ''))

                if 'attachment' in disposition:
                    filename = decode_str(part.get_filename() or 'unnamed')
                    attachments.append(filename)
                elif content_type == 'text/plain':
                    try:
                        charset = part.get_content_charset() or 'utf-8'
                        body_text = part.get_payload(decode=True).decode(charset, errors='replace')
                    except:
                        body_text = part.get_payload()
                elif content_type == 'text/html' and not body_text:
                    # 没有纯文本时提取 HTML
                    try:
                        charset = part.get_content_charset() or 'utf-8'
                        body_text = part.get_payload(decode=True).decode(charset, errors='replace')
                    except:
                        body_text = part.get_payload()

            print(body_text[:3000])
            if len(body_text) > 3000:
                print(f"\n... (正文共 {len(body_text)} 字符，已截断)")

            if attachments:
                print(f"\n📎 附件 ({len(attachments)}):")
                for a in attachments:
                    print(f"   - {a}")

            print("=" * 70)
    except Exception as e:
        print(f"❌ 读取失败：{e}")

# ============ 搜索邮件 ============
def cmd_search(conf, keyword, count=10):
    addr, pwd = get_credentials(conf)
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.login(addr, pwd)
            conn.select('INBOX')
            # 搜索主题和发件人
            status, messages = conn.search(None, f'(OR SUBJECT "{keyword}" FROM "{keyword}")')
            ids = messages[0].split()
            total = len(ids)
            recent_ids = ids[-count:] if total > count else ids
            recent_ids = list(reversed(recent_ids))

            if total == 0:
                print(f"🔍 未找到包含「{keyword}」的邮件")
                return

            print(f"\n🔍 搜索「{keyword}」（找到 {total} 封，显示最新 {len(recent_ids)} 封）")
            print("=" * 70)

            for eid in recent_ids:
                _, data = conn.fetch(eid, '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])')
                raw = data[0][1]
                msg = email.message_from_bytes(raw)
                subject = decode_str(msg.get('Subject', ''))
                sender = decode_str(msg.get('From', ''))
                date = format_date(msg.get('Date', ''))
                eid_str = eid.decode()
                print(f"  [{eid_str:>4}] {date}  {sender[:30]:<30}")
                print(f"         {subject[:50]}")
                print()

    except Exception as e:
        print(f"❌ 搜索失败：{e}")

# ============ 回复邮件 ============
def cmd_reply(conf, mail_id, body):
    addr, pwd = get_credentials(conf)
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.login(addr, pwd)
            conn.select('INBOX')
            _, data = conn.fetch(mail_id, '(RFC822)')
            if not data or not data[0]:
                print(f"❌ 找不到邮件 ID：{mail_id}")
                return
            raw = data[0][1]
            orig = email.message_from_bytes(raw)
            subject = decode_str(orig.get('Subject', ''))
            sender = decode_str(orig.get('From', ''))
            # 提取发件人邮箱
            if '<' in sender and '>' in sender:
                reply_to = sender[sender.index('<')+1:sender.index('>')]
            else:
                reply_to = sender

            # Re: 前缀
            if not subject.startswith('Re:'):
                subject = f"Re: {subject}"

            print(f"回复：{reply_to}")
            print(f"主题：{subject}")
            cmd_send(conf, reply_to, None, subject, body, None)

    except Exception as e:
        print(f"❌ 回复失败：{e}")

# ============ 配置 ============
def cmd_config(conf, args):
    if not args:
        print("📧 Gmail 配置")
        print("=" * 50)
        email_val = conf.get('email', '（未设置）')
        pwd_val = conf.get('app_password', '（未设置）')
        print(f"  邮箱：{email_val}")
        print(f"  应用专用密码：{'*' * len(pwd_val) if pwd_val else '（未设置）'}")
        print()
        print("设置方法：")
        print("  python3 gmail_tool.py config set email <邮箱地址>")
        print("  python3 gmail_tool.py config set app_password <应用专用密码>")
        print()
        print("获取应用专用密码：")
        print("  1. 访问 https://myaccount.google.com/apppasswords")
        print("  2. 登录 Google 账号")
        print("  3. 选择「邮件」应用，生成密码")
        print("  4. 复制 16 位密码（去掉空格）")
        return

    if args[0] == 'set' and len(args) >= 3:
        key = args[1]
        value = args[2]
        conf[key] = value
        save_conf(conf)
        print(f"✅ 已设置 {key}")
    else:
        print("用法：config set email <邮箱> 或 config set app_password <密码>")

# ============ 主程序 ============
def main():
    parser = argparse.ArgumentParser(description='Gmail 邮件工具')
    parser.add_argument('command', choices=['send', 'inbox', 'read', 'search', 'reply', 'config'])
    parser.add_argument('args', nargs='*', help='命令参数')
    args = parser.parse_args()

    conf = load_conf()

    if args.command == 'config':
        cmd_config(conf, args.args)
    elif args.command == 'send':
        if len(args.args) < 3:
            print("用法：send <收件人> <主题> <正文> [附件1] [附件2] ...")
            print("  正文可以是文件路径，也可以直接写内容")
            sys.exit(1)
        to_addr = args.args[0]
        subject = args.args[1]
        body_arg = args.args[2]
        # 正文：如果是文件就读内容，否则当纯文本
        if Path(body_arg).exists():
            body = Path(body_arg).read_text(encoding='utf-8')
        else:
            body = body_arg
        attachments = args.args[3:] if len(args.args) > 3 else None
        cmd_send(conf, to_addr, None, subject, body, attachments)
    elif args.command == 'inbox':
        count = int(args.args[0]) if args.args else 10
        cmd_inbox(conf, count)
    elif args.command == 'read':
        if not args.args:
            print("用法：read <邮件ID>")
            sys.exit(1)
        cmd_read(conf, args.args[0])
    elif args.command == 'search':
        if not args.args:
            print("用法：search <关键词> [数量]")
            sys.exit(1)
        keyword = args.args[0]
        count = int(args.args[1]) if len(args.args) > 1 else 10
        cmd_search(conf, keyword, count)
    elif args.command == 'reply':
        if len(args.args) < 2:
            print("用法：reply <邮件ID> <正文> 或 reply <邮件ID> <正文文件>")
            sys.exit(1)
        mail_id = args.args[0]
        body_arg = args.args[1]
        if Path(body_arg).exists():
            body = Path(body_arg).read_text(encoding='utf-8')
        else:
            body = body_arg
        cmd_reply(conf, mail_id, body)

if __name__ == "__main__":
    main()
