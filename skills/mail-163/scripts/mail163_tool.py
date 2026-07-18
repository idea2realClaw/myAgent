#!/usr/bin/env python3
"""163 邮箱邮件工具：支持收发邮件、搜索、回复，并兼容临时凭证模式。"""

import os
import sys
import json
import imaplib
import smtplib
import email
import argparse
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
from email.header import decode_header
from pathlib import Path

CONF_PATH = Path.home() / ".workbuddy" / "mail163.conf"
IMAP_SERVER = "imap.163.com"
IMAP_PORT = 993
SMTP_SERVER = "smtp.163.com"
SMTP_PORT = 465
IMAP_ID_FIELDS = (
    "name", "WorkBuddy mail-163",
    "version", "1.0.0",
    "vendor", "WorkBuddy",
    "support-email", "idea2realsoft@gmail.com",
)


def load_conf():

    if CONF_PATH.exists():
        with open(CONF_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_conf(conf):
    CONF_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONF_PATH, "w", encoding="utf-8") as f:
        json.dump(conf, f, indent=2, ensure_ascii=False)
    os.chmod(CONF_PATH, 0o600)


def decode_str(s):
    if s is None:
        return ""
    parts = decode_header(s)
    result = []
    for data, charset in parts:
        if isinstance(data, bytes):
            result.append(data.decode(charset or "utf-8", errors="replace"))
        else:
            result.append(data)
    return "".join(result)


def format_size(n):
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def format_date(date_str):
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(date_str)
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return date_str


def get_credentials(conf, args):
    addr = args.email or os.environ.get("MAIL163_EMAIL") or conf.get("email")
    auth_code = args.auth_code or os.environ.get("MAIL163_AUTH_CODE") or conf.get("auth_code")
    if not addr or not auth_code:
        print("❌ 未提供 163 邮箱地址或授权码")
        print("   可用方式 1：python mail163_tool.py --email xxx@163.com --auth-code xxxxx inbox")
        print("   可用方式 2：python mail163_tool.py config set email <邮箱>")
        print("              python mail163_tool.py config set auth_code <授权码>")
        sys.exit(1)
    return addr, auth_code


def prepare_imap(conn):
    if "ID" not in imaplib.Commands:
        imaplib.Commands["ID"] = ("AUTH",)
    payload = '("' + '" "'.join(IMAP_ID_FIELDS) + '")'
    typ, data = conn._simple_command("ID", payload)
    conn._untagged_response(typ, data, "ID")


def select_inbox(conn):
    typ, data = conn.select("INBOX")
    if typ != "OK":
        reason = data[0].decode("utf-8", errors="replace") if data and data[0] else "SELECT INBOX failed"
        raise imaplib.IMAP4.error(reason)


def cmd_send(conf, args, to_addr, subject, body, attachments):

    addr, auth_code = get_credentials(conf, args)

    msg = MIMEMultipart()
    msg["From"] = addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg.attach(MIMEText(body, "plain", "utf-8"))

    all_recipients = [to_addr]
    for filepath in attachments or []:
        path = Path(filepath)
        if not path.exists():
            print(f"⚠️ 附件不存在：{filepath}")
            continue
        with open(path, "rb") as f:
            part = MIMEApplication(f.read(), Name=path.name)
        part["Content-Disposition"] = f'attachment; filename="{path.name}"'
        msg.attach(part)
        print(f"📎 附件：{path.name} ({format_size(path.stat().st_size)})")

    try:
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT) as server:
            server.login(addr, auth_code)
            server.sendmail(addr, all_recipients, msg.as_string())
        print("✅ 邮件已发送！")
        print(f"   发件人：{addr}")
        print(f"   收件人：{to_addr}")
        print(f"   主  题：{subject}")
    except smtplib.SMTPAuthenticationError:
        print("❌ 认证失败！请检查 163 邮箱地址和客户端授权码是否正确")
    except Exception as exc:
        print(f"❌ 发送失败：{exc}")


def cmd_inbox(conf, args, count=10):
    addr, auth_code = get_credentials(conf, args)
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.login(addr, auth_code)
            prepare_imap(conn)
            select_inbox(conn)
            _, messages = conn.search(None, "ALL")

            ids = messages[0].split()
            total = len(ids)
            recent_ids = ids[-count:] if total > count else ids
            recent_ids = list(reversed(recent_ids))

            print(f"\n📧 收件箱（最新 {len(recent_ids)} / 共 {total} 封）")
            print("=" * 70)
            for eid in recent_ids:
                _, data = conn.fetch(eid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
                raw = data[0][1]
                msg = email.message_from_bytes(raw)
                subject = decode_str(msg.get("Subject", "（无主题）"))
                sender = decode_str(msg.get("From", ""))
                date = format_date(msg.get("Date", ""))
                eid_str = eid.decode()
                display_sub = subject[:45] + "..." if len(subject) > 48 else subject
                print(f"  [{eid_str:>4}] {date}  {sender[:30]:<30}")
                print(f"         {display_sub}")
                print()
    except imaplib.IMAP4.error as exc:
        print(f"❌ 登录失败：{exc}")
        print("   请检查 163 邮箱地址和客户端授权码")
    except Exception as exc:
        print(f"❌ 收件箱读取失败：{exc}")


def extract_body_and_attachments(msg):
    body_text = ""
    attachments = []
    for part in msg.walk():
        content_type = part.get_content_type()
        disposition = str(part.get("Content-Disposition", ""))

        if "attachment" in disposition:
            filename = decode_str(part.get_filename() or "unnamed")
            attachments.append(filename)
        elif content_type == "text/plain":
            try:
                charset = part.get_content_charset() or "utf-8"
                body_text = part.get_payload(decode=True).decode(charset, errors="replace")
            except Exception:
                body_text = str(part.get_payload())
        elif content_type == "text/html" and not body_text:
            try:
                charset = part.get_content_charset() or "utf-8"
                body_text = part.get_payload(decode=True).decode(charset, errors="replace")
            except Exception:
                body_text = str(part.get_payload())
    return body_text, attachments


def cmd_read(conf, args, mail_id):
    addr, auth_code = get_credentials(conf, args)
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.login(addr, auth_code)
            prepare_imap(conn)
            select_inbox(conn)
            _, data = conn.fetch(mail_id, "(RFC822)")
            if not data or not data[0]:
                print(f"❌ 找不到邮件 ID：{mail_id}")
                return

            raw = data[0][1]
            msg = email.message_from_bytes(raw)

            print("=" * 70)
            print("📬 邮件详情")
            print("=" * 70)
            print(f"  发件人：{decode_str(msg.get('From', ''))}")
            print(f"  收件人：{decode_str(msg.get('To', ''))}")
            cc = msg.get("Cc")
            if cc:
                print(f"  抄  送：{decode_str(cc)}")
            print(f"  日  期：{format_date(msg.get('Date', ''))}")
            print(f"  主  题：{decode_str(msg.get('Subject', ''))}")
            print("-" * 70)

            body_text, attachments = extract_body_and_attachments(msg)
            print(body_text[:3000])
            if len(body_text) > 3000:
                print(f"\n... (正文共 {len(body_text)} 字符，已截断)")

            if attachments:
                print(f"\n📎 附件 ({len(attachments)}):")
                for attachment in attachments:
                    print(f"   - {attachment}")

            print("=" * 70)
    except Exception as exc:
        print(f"❌ 读取失败：{exc}")


def cmd_search(conf, args, keyword, count=10):
    addr, auth_code = get_credentials(conf, args)
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.login(addr, auth_code)
            prepare_imap(conn)
            select_inbox(conn)
            query = f'(OR SUBJECT "{keyword}" FROM "{keyword}")'

            _, messages = conn.search(None, query)
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
                _, data = conn.fetch(eid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
                raw = data[0][1]
                msg = email.message_from_bytes(raw)
                subject = decode_str(msg.get("Subject", ""))
                sender = decode_str(msg.get("From", ""))
                date = format_date(msg.get("Date", ""))
                eid_str = eid.decode()
                print(f"  [{eid_str:>4}] {date}  {sender[:30]:<30}")
                print(f"         {subject[:50]}")
                print()
    except Exception as exc:
        print(f"❌ 搜索失败：{exc}")


def cmd_reply(conf, args, mail_id, body):
    addr, auth_code = get_credentials(conf, args)
    try:
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT) as conn:
            conn.login(addr, auth_code)
            prepare_imap(conn)
            select_inbox(conn)
            _, data = conn.fetch(mail_id, "(RFC822)")

            if not data or not data[0]:
                print(f"❌ 找不到邮件 ID：{mail_id}")
                return
            raw = data[0][1]
            orig = email.message_from_bytes(raw)
            subject = decode_str(orig.get("Subject", ""))
            sender = decode_str(orig.get("From", ""))
            if "<" in sender and ">" in sender:
                reply_to = sender[sender.index("<") + 1:sender.index(">")]
            else:
                reply_to = sender

            if not subject.startswith("Re:"):
                subject = f"Re: {subject}"

            print(f"回复：{reply_to}")
            print(f"主题：{subject}")
            cmd_send(conf, args, reply_to, subject, body, None)
    except Exception as exc:
        print(f"❌ 回复失败：{exc}")


def cmd_config(conf, args):
    if not args:
        print("📧 163 邮箱配置")
        print("=" * 50)
        email_val = conf.get("email", "（未设置）")
        auth_val = conf.get("auth_code", "")
        masked = "*" * len(auth_val) if auth_val else "（未设置）"
        print(f"  邮箱：{email_val}")
        print(f"  客户端授权码：{masked}")
        print()
        print("设置方法：")
        print("  python mail163_tool.py config set email <邮箱地址>")
        print("  python mail163_tool.py config set auth_code <客户端授权码>")
        print()
        print("临时使用（不落盘）：")
        print("  python mail163_tool.py --email xxx@163.com --auth-code xxxxx inbox")
        return

    if args[0] == "set" and len(args) >= 3:
        key = args[1]
        value = args[2]
        if key not in {"email", "auth_code"}:
            print("❌ 仅支持设置 email 或 auth_code")
            return
        conf[key] = value
        save_conf(conf)
        print(f"✅ 已设置 {key}")
    else:
        print("用法：config set email <邮箱> 或 config set auth_code <授权码>")


def build_parser():
    parser = argparse.ArgumentParser(description="163 邮箱邮件工具")
    parser.add_argument("--email", help="163 邮箱地址，优先于配置文件")
    parser.add_argument("--auth-code", help="163 客户端授权码，优先于配置文件")
    parser.add_argument("command", choices=["send", "inbox", "read", "search", "reply", "config"])
    parser.add_argument("args", nargs="*", help="命令参数")
    return parser


def main():
    parser = build_parser()
    parsed = parser.parse_args()
    conf = load_conf()

    if parsed.command == "config":
        cmd_config(conf, parsed.args)
    elif parsed.command == "send":
        if len(parsed.args) < 3:
            print("用法：send <收件人> <主题> <正文> [附件1] [附件2] ...")
            print("  正文可以是文件路径，也可以直接写内容")
            sys.exit(1)
        to_addr = parsed.args[0]
        subject = parsed.args[1]
        body_arg = parsed.args[2]
        body = Path(body_arg).read_text(encoding="utf-8") if Path(body_arg).exists() else body_arg
        attachments = parsed.args[3:] if len(parsed.args) > 3 else None
        cmd_send(conf, parsed, to_addr, subject, body, attachments)
    elif parsed.command == "inbox":
        count = int(parsed.args[0]) if parsed.args else 10
        cmd_inbox(conf, parsed, count)
    elif parsed.command == "read":
        if not parsed.args:
            print("用法：read <邮件ID>")
            sys.exit(1)
        cmd_read(conf, parsed, parsed.args[0])
    elif parsed.command == "search":
        if not parsed.args:
            print("用法：search <关键词> [数量]")
            sys.exit(1)
        keyword = parsed.args[0]
        count = int(parsed.args[1]) if len(parsed.args) > 1 else 10
        cmd_search(conf, parsed, keyword, count)
    elif parsed.command == "reply":
        if len(parsed.args) < 2:
            print("用法：reply <邮件ID> <正文> 或 reply <邮件ID> <正文文件>")
            sys.exit(1)
        mail_id = parsed.args[0]
        body_arg = parsed.args[1]
        body = Path(body_arg).read_text(encoding="utf-8") if Path(body_arg).exists() else body_arg
        cmd_reply(conf, parsed, mail_id, body)


if __name__ == "__main__":
    main()
