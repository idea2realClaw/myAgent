#!/usr/bin/env python3
"""
自我反省与成长工具
用法：
  python3 reflection.py record           # 交互式记录反省
  python3 reflection.py record --json '{}'  # JSON 格式记录
  python3 reflection.py list [类型] [数量]  # 查看日志
  python3 reflection.py report --days 7     # 生成报告
  python3 reflection.py search <关键词>     # 搜索
"""

import os
import sys
import json
import argparse
from datetime import datetime, timedelta
from pathlib import Path

# ============ 配置 ============
REFLECTION_DIR = Path.home() / ".workbuddy" / "reflections"
LOG_FILE = REFLECTION_DIR / "reflections.json"

# 确保目录存在
REFLECTION_DIR.mkdir(parents=True, exist_ok=True)


# ============ 数据管理 ============
def load_reflections():
    """加载所有反省记录"""
    if LOG_FILE.exists():
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_reflection(reflection):
    """保存单条反省记录"""
    reflections = load_reflections()
    reflection["id"] = len(reflections) + 1
    reflection["timestamp"] = datetime.now().isoformat()
    reflection["date"] = datetime.now().strftime("%Y-%m-%d")
    reflections.insert(0, reflection)  # 最新的在前
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        json.dump(reflections, f, indent=2, ensure_ascii=False)
    return reflection["id"]


# ============ 交互式记录 ============
def interactive_record():
    """交互式记录反省"""
    print("📝 记录反省")
    print("=" * 50)

    # 选择类型
    print("\n类型：")
    print("  1. 错误（踩坑）")
    print("  2. 成功（亮点）")
    print("  3. 流程优化")
    print("  4. 学习借鉴")
    type_choice = input("\n请选择 [1-4]: ").strip()
    type_map = {"1": "error", "2": "success", "3": "process", "4": "learn"}
    ref_type = type_map.get(type_choice, "error")

    # 填写内容
    what = input("\n发生了什么？: ").strip()
    why = input("原因分析？: ").strip()
    how = input("改进方案？: ").strip()

    if not what:
        print("❌ 内容不能为空")
        sys.exit(1)

    reflection = {
        "type": ref_type,
        "what": what,
        "why": why,
        "how": how,
    }

    rid = save_reflection(reflection)
    print(f"\n✅ 反省已保存（ID: {rid}）")


# ============ 列表查看 ============
def list_reflections(ref_type=None, count=None):
    """查看反省列表"""
    reflections = load_reflections()

    # 筛选类型
    if ref_type:
        reflections = [r for r in reflections if r["type"] == ref_type]

    # 限制数量
    if count:
        reflections = reflections[:count]

    if not reflections:
        print("📭 暂无反省记录")
        return

    type_labels = {
        "error": "❌ 错误",
        "success": "✅ 成功",
        "process": "🔄 流程",
        "learn": "📚 学习",
    }

    print(f"\n📋 反反省日志（共 {len(reflections)} 条）")
    print("=" * 60)

    for r in reflections:
        type_label = type_labels.get(r["type"], "📝 其他")
        print(f"\n  [{r['id']:>4}] {type_label}  {r['date']}")
        print(f"         {r['what'][:55]}{'…' if len(r['what']) > 55 else ''}")
        if r.get("why"):
            print(f"         ↳ {r['why'][:45]}{'…' if len(r['why']) > 45 else ''}")


# ============ 生成报告 ============
def generate_report(days=7):
    """生成改进报告"""
    reflections = load_reflections()
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    recent = [r for r in reflections if r["timestamp"] > cutoff]

    if not recent:
        print(f"📭 近 {days} 天无反省记录")
        return

    # 按类型统计
    by_type = {"error": [], "success": [], "process": [], "learn": []}
    for r in recent:
        t = r["type"]
        if t in by_type:
            by_type[t].append(r)

    type_labels = {
        "error": "❌ 错误与改进",
        "success": "✅ 成功经验",
        "process": "🔄 流程优化",
        "learn": "📚 学习借鉴",
    }

    print(f"\n📊 反反省报告（近 {days} 天）")
    print("=" * 70)

    for t, items in by_type.items():
        if items:
            print(f"\n{type_labels[t]} ({len(items)} 条)")
            print("-" * 70)
            for r in items:
                print(f"  [{r['date']}] {r['what'][:60]}")
                if r.get("how"):
                    print(f"  → {r['how'][:60]}")
                print()

    # 改进建议
    errors = by_type.get("error", [])
    if errors:
        print("\n💡 下周重点改进：")
        for e in errors[:5]:
            print(f"  • {e['how'][:60]}")
        print()


# ============ 搜索 ============
def search_reflections(keyword):
    """搜索反省记录"""
    reflections = load_reflections()
    keyword_lower = keyword.lower()

    results = []
    for r in reflections:
        if (keyword_lower in r["what"].lower() or
            keyword_lower in r.get("why", "").lower() or
            keyword_lower in r.get("how", "").lower()):
            results.append(r)

    if not results:
        print(f"🔍 未找到包含「{keyword}」的记录")
        return

    type_labels = {
        "error": "❌",
        "success": "✅",
        "process": "🔄",
        "learn": "📚",
    }

    print(f"\n🔍 搜索「{keyword}」（找到 {len(results)} 条）")
    print("=" * 70)

    for r in results:
        type_label = type_labels.get(r["type"], "📝")
        print(f"\n  {type_label} [{r['date']}] {r['what'][:55]}")
        if r.get("why"):
            print(f"  ↳ {r['why'][:55]}")
        if r.get("how"):
            print(f"  → {r['how'][:55]}")


# ============ 主程序 ============
def main():
    parser = argparse.ArgumentParser(description="自我反省与成长工具")
    parser.add_argument("command", choices=["record", "list", "report", "search"])
    parser.add_argument("args", nargs="*", help="命令参数")
    parser.add_argument("--json", help="JSON 格式记录", default=None)
    parser.add_argument("--days", type=int, default=7, help="报告天数")
    args = parser.parse_args()

    if args.command == "record":
        if args.json:
            # JSON 格式记录
            try:
                reflection = json.loads(args.json)
                rid = save_reflection(reflection)
                print(f"✅ 反省已保存（ID: {rid}）")
            except json.JSONDecodeError as e:
                print(f"❌ JSON 格式错误：{e}")
                sys.exit(1)
        else:
            interactive_record()

    elif args.command == "list":
        ref_type = None
        count = None

        for arg in args.args:
            if arg in ["error", "success", "process", "learn"]:
                ref_type = arg
            elif arg.isdigit():
                count = int(arg)

        list_reflections(ref_type, count)

    elif args.command == "report":
        generate_report(args.days)

    elif args.command == "search":
        if not args.args:
            print("用法：search <关键词>")
            sys.exit(1)
        search_reflections(args.args[0])


if __name__ == "__main__":
    main()
