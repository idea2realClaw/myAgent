#!/usr/bin/env python3
"""
ventus-booking-monitor: 瑞典大使馆护照预约监控脚本
用法：
  python3 check_booking.py                              # 单次检查，打印结果
  python3 check_booking.py --notify EMAIL               # 找到空位发邮件
  python3 check_booking.py --interval 30 --notify EMAIL # 每30分钟轮询
  python3 check_booking.py --location UDDLondon         # 指定地点
"""

import subprocess
import sys
import os
import re
import time
import argparse
import tempfile
from datetime import datetime

# Playwright CLI 路径
PCLI = "node ~/.workbuddy/plugins/marketplaces/codebuddy-plugins-official/plugins/playwright-cli/playwright-cli.js"
GMAIL_TOOL = "python3 ~/.workbuddy/skills/gmail/scripts/gmail_tool.py"

def pcli(cmd, capture=True):
    """执行 playwright-cli 命令"""
    full_cmd = f"{PCLI} {cmd}"
    result = subprocess.run(
        full_cmd, shell=True,
        capture_output=capture, text=True,
        timeout=30
    )
    return result.stdout + result.stderr

def snapshot_to_tmp(name="snap"):
    """获取当前页面快照，返回内容字符串"""
    with tempfile.NamedTemporaryFile(suffix='.yaml', delete=False, prefix=f'ventus_{name}_') as f:
        tmp_path = f.name
    # playwright-cli 会保存到 .playwright-cli 目录，我们指定文件名
    filename = os.path.basename(tmp_path)
    pcli(f"snapshot --filename={filename}")
    # 检查 .playwright-cli 目录
    snap_dir = os.path.expanduser("~/.playwright-cli")
    cwd_snap = os.path.join(os.getcwd(), ".playwright-cli", filename)
    if os.path.exists(cwd_snap):
        with open(cwd_snap) as f:
            return f.read()
    # 回退：直接读 tmp
    if os.path.exists(tmp_path):
        with open(tmp_path) as f:
            return f.read()
    return ""

def find_ref(yaml_content, *keywords):
    """
    在 YAML 快照中查找包含关键词的元素的 ref。
    返回第一个匹配的 ref 字符串，如 'e14'。
    keywords 可以是多个，全部包含才算匹配。
    """
    for line in yaml_content.splitlines():
        if all(kw.lower() in line.lower() for kw in keywords):
            m = re.search(r'\[ref=(e\d+)\]', line)
            if m:
                return m.group(1)
    return None

def parse_available_times(yaml_content):
    """
    从快照 YAML 中解析可用预约时间。
    返回列表：[{"datetime": "2026-04-07 09:45:00", "display": "Tue 7 Apr 09:45"}, ...]
    """
    times = []
    # 查找 cursor=pointer 且文字像时间的 row
    # 格式: row "2026-04-07 09:45:00" [ref=eXX] [cursor=pointer]: 09:45
    pattern = re.compile(
        r'row "(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})" \[ref=\S+\] \[cursor=pointer\]:\s*(\d{2}:\d{2})'
    )
    # 也需要列头来知道星期几
    col_pattern = re.compile(r'columnheader "(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d+) (\w+)"')
    
    # 提取列头（日期）
    headers = col_pattern.findall(yaml_content)
    
    for m in pattern.finditer(yaml_content):
        dt_str = m.group(1)       # "2026-04-07 09:45:00"
        time_str = m.group(2)     # "09:45"
        try:
            dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
            # 找到对应的列头
            day_label = dt.strftime("%a %-d %b")
            for h in headers:
                h_label = f"{h[0]} {h[1]} {h[2]}"
                # e.g. "Tue 7 Apr"
                if h[0] in dt.strftime("%a") and str(dt.day) == h[1]:
                    day_label = h_label
                    break
            times.append({
                "datetime": dt_str,
                "dt": dt,
                "display": f"{day_label} {time_str}",
                "date_cn": dt.strftime(f"%Y年%-m月%-d日（{weekday_cn(dt.weekday())}）"),
                "time": time_str
            })
        except Exception:
            pass
    return times

def weekday_cn(wd):
    return ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][wd]

def check_once(location="UDDLondon"):
    """执行一次完整的预约检查，返回可用时间列表"""
    base_url = f"https://ventus.enalog.se/Booking/Booking/Index/{location}"
    print(f"[{datetime.now().strftime('%H:%M:%S')}] 打开页面：{base_url}")

    # Step 1: 打开页面
    pcli(f"open {base_url}")
    time.sleep(2)

    # Step 2: 截取快照，找 English 按钮
    snap = snapshot_to_tmp("s1")
    en_ref = find_ref(snap, "link", "English", "en-GB")
    if not en_ref:
        # 尝试另一种方式
        en_ref = find_ref(snap, "English")
    if en_ref:
        print(f"  切换英文 [{en_ref}]")
        pcli(f"click {en_ref}")
        time.sleep(1)
        snap = snapshot_to_tmp("s2")
    else:
        print("  警告：未找到英文切换按钮，尝试继续...")

    # Step 3: 点击 Book an appointment
    book_ref = find_ref(snap, "Book")
    if not book_ref:
        book_ref = find_ref(snap, "button", "Book")
    if not book_ref:
        print("  错误：未找到 Book an appointment 按钮")
        return []
    print(f"  点击 Book [{book_ref}]")
    pcli(f"click {book_ref}")
    time.sleep(1)

    # Step 4: Agreement 页 - 勾选 + Next
    snap = snapshot_to_tmp("s3")
    cb_ref = find_ref(snap, "checkbox")
    next_ref = find_ref(snap, 'button "Next"')
    if not next_ref:
        next_ref = find_ref(snap, "button", "Next")
    if cb_ref:
        pcli(f"check {cb_ref}")
        time.sleep(0.5)
    if next_ref:
        print(f"  Agreement: Next [{next_ref}]")
        pcli(f"click {next_ref}")
        time.sleep(1)

    # Step 5: Service 页 - 选 Passport
    snap = snapshot_to_tmp("s4")
    passport_ref = find_ref(snap, "Passport")
    next_ref = find_ref(snap, 'button "Next"') or find_ref(snap, "button", "Next")
    if passport_ref:
        print(f"  选择 Passport application [{passport_ref}]")
        pcli(f"click {passport_ref}")
        time.sleep(0.5)
    if next_ref:
        pcli(f"click {next_ref}")
        time.sleep(1)

    # Step 6: Conditional 页 - 勾选 + Next
    snap = snapshot_to_tmp("s5")
    cb_ref = find_ref(snap, "checkbox")
    next_ref = find_ref(snap, 'button "Next"') or find_ref(snap, "button", "Next")
    if cb_ref:
        pcli(f"check {cb_ref}")
        time.sleep(0.5)
    if next_ref:
        print(f"  Conditional: Next [{next_ref}]")
        pcli(f"click {next_ref}")
        time.sleep(1)

    # Step 7: Select time 页 - 点 First available time
    snap = snapshot_to_tmp("s6")
    first_ref = find_ref(snap, "First available time")
    if not first_ref:
        first_ref = find_ref(snap, "First")
    if first_ref:
        print(f"  First available time [{first_ref}]")
        pcli(f"click {first_ref}")
        time.sleep(2)
    else:
        print("  错误：未找到 First available time 按钮")
        return []

    # Step 8: 解析时间
    snap = snapshot_to_tmp("result")
    times = parse_available_times(snap)
    return times

def send_notification(email, times, location="UDDLondon"):
    """发邮件通知"""
    booking_url = f"https://ventus.enalog.se/Booking/Booking/Index/{location}"
    
    time_list = "\n".join([
        f"  📅 {t['date_cn']} {t['time']}"
        for t in times
    ])
    
    body = f"""师父，

我刚刚检查了瑞典驻伦敦大使馆的护照预约系统，发现有可用时间！

✅ 可预约时间：
{'━' * 30}
{time_list}
{'━' * 30}

请快去预约！

🔗 预约链接：
{booking_url}

预约步骤：
1. 点击上面链接
2. 点击 Book an appointment
3. 同意条款（勾选 checkbox）→ 点 Next
4. 选择 Passport application → 点 Next
5. 阅读海外居民须知（勾选）→ 点 Next
6. 在日历中选择上面的时间段
7. 填写个人信息完成预约

⚡ 时间紧张，趁还没被别人抢走！

— 龙木心（自动监控）
检查时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
"""
    subject = f"🚨 瑞典大使馆护照预约有空位！快去抢！（{times[0]['date_cn']} {times[0]['time']}）"
    
    cmd = f"{GMAIL_TOOL} send {email} \"{subject}\" \"{body}\""
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode == 0:
        print(f"  ✅ 邮件已发送到 {email}")
    else:
        print(f"  ❌ 邮件发送失败：{result.stderr}")

def main():
    parser = argparse.ArgumentParser(description="瑞典大使馆预约监控")
    parser.add_argument("--location", default="UDDLondon", help="大使馆地点代码（默认：UDDLondon）")
    parser.add_argument("--notify", default=None, help="找到空位时发送邮件到此地址")
    parser.add_argument("--interval", type=int, default=0, help="轮询间隔（分钟），0=只查一次")
    args = parser.parse_args()

    def run_check():
        times = check_once(args.location)
        if times:
            print(f"\n✅ 找到 {len(times)} 个可用时间：")
            for t in times:
                print(f"   {t['date_cn']} {t['time']}")
            if args.notify:
                send_notification(args.notify, times, args.location)
            return True
        else:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] ❌ 暂无可用时间")
            return False

    if args.interval > 0:
        print(f"开始轮询，每 {args.interval} 分钟检查一次...")
        while True:
            found = run_check()
            if found and args.notify:
                print("已发送邮件通知，停止轮询。")
                break
            print(f"  等待 {args.interval} 分钟后再次检查...")
            time.sleep(args.interval * 60)
    else:
        run_check()

if __name__ == "__main__":
    main()
