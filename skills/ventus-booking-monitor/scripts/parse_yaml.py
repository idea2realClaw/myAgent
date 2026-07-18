#!/usr/bin/env python3
"""
parse_yaml.py - 解析 playwright-cli snapshot YAML，提取预约时间信息
用法：
  python3 parse_yaml.py times.yaml
  python3 parse_yaml.py times.yaml --json
  cat times.yaml | python3 parse_yaml.py -
"""

import sys
import re
import json
import argparse
from datetime import datetime

def weekday_cn(wd):
    return ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][wd]

def parse_available_times(content):
    """
    从 playwright-cli 快照 YAML 中解析可用预约时间。

    可用时间的 YAML 特征：
    - row "2026-04-07 09:45:00" [ref=eXX] [cursor=pointer]: 09:45

    无可用时间特征：
    - 所有 cell 都为空（无 cursor=pointer 的 row 子元素）
    """
    times = []
    pattern = re.compile(
        r'row "(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})" \[ref=\S+\] \[cursor=pointer\]:\s*(\d{2}:\d{2})'
    )
    
    for m in pattern.finditer(content):
        dt_str = m.group(1)
        time_str = m.group(2)
        try:
            dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
            times.append({
                "datetime": dt_str,
                "date": dt.strftime("%Y-%m-%d"),
                "time": time_str,
                "weekday": dt.strftime("%A"),
                "weekday_cn": weekday_cn(dt.weekday()),
                "display_cn": f"{dt.year}年{dt.month}月{dt.day}日（{weekday_cn(dt.weekday())}）{time_str}",
                "display_en": f"{dt.strftime('%a %d %b')} {time_str}"
            })
        except Exception:
            pass
    return times

def parse_current_week(content):
    """提取当前显示的是哪一周"""
    col_pattern = re.compile(r'columnheader "(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d+) (\w+)"')
    headers = col_pattern.findall(content)
    if headers:
        return [f"{h[0]} {h[1]} {h[2]}" for h in headers]
    return []

def has_no_availability_message(content):
    """检查是否有'无空位'相关提示"""
    no_avail_patterns = [
        "no available appointments",
        "no appointments available",
        "inga lediga tider",  # 瑞典语
        "inga tillgängliga tider"
    ]
    content_lower = content.lower()
    return any(p in content_lower for p in no_avail_patterns)

def main():
    parser = argparse.ArgumentParser(description="解析 Ventus 预约系统快照")
    parser.add_argument("file", help="YAML 文件路径，'-' 表示从 stdin 读取")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出")
    args = parser.parse_args()

    if args.file == "-":
        content = sys.stdin.read()
    else:
        with open(args.file, encoding="utf-8") as f:
            content = f.read()

    times = parse_available_times(content)
    week = parse_current_week(content)
    no_avail = has_no_availability_message(content)

    if args.json:
        print(json.dumps({
            "available": len(times) > 0,
            "count": len(times),
            "times": times,
            "current_week": week,
            "no_availability_message": no_avail
        }, ensure_ascii=False, indent=2))
    else:
        if times:
            print(f"✅ 找到 {len(times)} 个可用时间：")
            for t in times:
                print(f"   {t['display_cn']}")
        else:
            print("❌ 本周无可用时间")
            if week:
                print(f"   当前显示周：{' | '.join(week)}")
            if no_avail:
                print("   页面显示：无可用预约时间")

if __name__ == "__main__":
    main()
