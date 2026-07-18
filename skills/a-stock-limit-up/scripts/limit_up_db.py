"""
涨停分析数据库模块
用于保存每日涨停原始数据，支持后续胜率分析
"""

import json
import os
from datetime import datetime
from typing import List, Dict, Optional
from pathlib import Path


class LimitUpDB:
    """涨停分析JSON数据库"""

    def __init__(self, db_path: Optional[str] = None):
        """
        初始化数据库
        db_path: 数据库文件路径，默认 ~/.workbuddy/limit_up_db.json
        """
        if db_path is None:
            home = os.path.expanduser("~")
            self.db_path = os.path.join(home, ".workbuddy", "limit_up_db.json")
        else:
            self.db_path = db_path

        # 确保目录存在
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

        # 初始化数据库结构
        if not os.path.exists(self.db_path):
            self._init_db()

    def _init_db(self):
        """初始化空数据库"""
        db = {
            "version": "1.0",
            "created_at": datetime.now().isoformat(),
            "last_updated": datetime.now().isoformat(),
            "days": {}
        }
        self._save_db(db)

    def _load_db(self) -> Dict:
        """加载数据库"""
        try:
            with open(self.db_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            self._init_db()
            with open(self.db_path, 'r', encoding='utf-8') as f:
                return json.load(f)

    def _save_db(self, db: Dict):
        """保存数据库"""
        db["last_updated"] = datetime.now().isoformat()
        with open(self.db_path, 'w', encoding='utf-8') as f:
            json.dump(db, f, ensure_ascii=False, indent=2)

    def save_day(self, date: str, stocks: List[Dict], market_summary: Optional[Dict] = None, top_stock: Optional[Dict] = None) -> bool:
        """
        保存某日的涨停数据

        Args:
            date: 日期，格式 YYYY-MM-DD
            stocks: 涨停股票列表
            market_summary: 市场概况（可选）
            top_stock: 当日评分最高的股票信息（可选）

        Returns:
            是否保存成功
        """
        if not date or not stocks:
            return False

        db = self._load_db()

        # 构建当日记录
        day_record = {
            "date": date,
            "saved_at": datetime.now().isoformat(),
            "total_count": len(stocks),
            "main_board_count": sum(1 for s in stocks if not s.get('is_chip', False)),
            "chip_board_count": sum(1 for s in stocks if s.get('is_chip', False)),
            "market_summary": market_summary or {},
            "stocks": stocks,
        }

        # 保存最高分股票信息
        if top_stock:
            day_record["top_stock"] = top_stock

        # 保存到数据库
        db["days"][date] = day_record
        self._save_db(db)

        return True

    def get_day(self, date: str) -> Optional[Dict]:
        """获取某日的涨停数据"""
        db = self._load_db()
        return db.get("days", {}).get(date)

    def get_all_days(self) -> List[str]:
        """获取所有有数据的日期"""
        db = self._load_db()
        return sorted(db.get("days", {}).keys(), reverse=True)

    def get_all_records(self) -> List[Dict]:
        """获取所有记录，按日期降序"""
        db = self._load_db()
        days = db.get("days", {})
        return [days[d] for d in sorted(days.keys(), reverse=True)]

    def add_follow_up(self, date: str, next_date: str, stocks_with_followup: List[Dict]) -> bool:
        """
        添加次日涨跌跟踪数据

        Args:
            date: 昨日涨停日期
            next_date: 今日日期
            stocks_with_followup: 包含次日表现数据的股票列表
                                 每只股票需要包含:
                                 - code: 股票代码
                                 - next_open: 今日开盘价
                                 - next_close: 今日收盘价
                                 - next_pct: 今日涨跌幅
                                 - open_profit: 开盘买入盈亏率
                                 - close_profit: 收盘盈亏率
                                 - can_buy: 开盘能否买入
        """
        db = self._load_db()
        day_record = db.get("days", {}).get(date)

        if not day_record:
            return False

        # 构建跟踪记录
        followup = {
            "followup_date": next_date,
            "saved_at": datetime.now().isoformat(),
            "total_followed": len(stocks_with_followup),
            "can_buy_count": sum(1 for s in stocks_with_followup if s.get('can_buy', False)),
            "profitable_open": sum(1 for s in stocks_with_followup if s.get('open_profit', 0) > 0),
            "profitable_close": sum(1 for s in stocks_with_followup if s.get('close_profit', 0) > 0),
            "avg_open_profit": self._calc_avg(stocks_with_followup, 'open_profit'),
            "avg_close_profit": self._calc_avg(stocks_with_followup, 'close_profit'),
            "stocks": stocks_with_followup
        }

        # 保存跟踪数据
        if "followup" not in day_record:
            day_record["followup"] = []
        day_record["followup"].append(followup)

        db["days"][date] = day_record
        self._save_db(db)

        return True

    def _calc_avg(self, stocks: List[Dict], key: str) -> float:
        """计算平均值"""
        values = [s.get(key, 0) for s in stocks if key in s]
        return sum(values) / len(values) if values else 0.0

    def analyze_win_rate(self, min_sample: int = 2) -> Dict:
        """
        分析胜率统计数据

        Args:
            min_sample: 最少样本数

        Returns:
            胜率统计结果
        """
        db = self._load_db()
        days = db.get("days", {})

        results = {
            "total_days": 0,
            "total_stocks": 0,
            "open_can_buy_total": 0,
            "open_profitable_count": 0,
            "close_profitable_count": 0,
            "avg_open_profit": 0,
            "avg_close_profit": 0,
            "daily_stats": [],
            "conclusion": ""
        }

        open_profits = []
        close_profits = []
        open_can_buy_total = 0
        open_profitable = 0
        close_profitable = 0

        for date, day_data in sorted(days.items()):
            followups = day_data.get("followup", [])
            if not followups:
                continue

            # 取最新的跟踪数据
            fu = followups[-1]
            total = fu["total_followed"]
            can_buy = fu.get("can_buy_count", 0)
            profitable_open = fu.get("profitable_open", 0)
            profitable_close = fu.get("profitable_close", 0)
            avg_open = fu.get("avg_open_profit", 0)
            avg_close = fu.get("avg_close_profit", 0)

            open_can_buy_total += can_buy
            open_profitable += profitable_open
            close_profitable += profitable_close

            if avg_open != 0:
                open_profits.append(avg_open)
            if avg_close != 0:
                close_profits.append(avg_close)

            results["daily_stats"].append({
                "date": date,
                "total": total,
                "can_buy": can_buy,
                "open_profitable": profitable_open,
                "close_profitable": profitable_close,
                "open_win_rate": profitable_open / can_buy if can_buy > 0 else 0,
                "close_win_rate": profitable_close / total if total > 0 else 0,
                "avg_open_profit": avg_open,
                "avg_close_profit": avg_close
            })

        results["total_days"] = len(results["daily_stats"])
        results["total_stocks"] = sum(s["total"] for s in results["daily_stats"])

        if open_can_buy_total >= min_sample:
            results["open_can_buy_total"] = open_can_buy_total
            results["open_profitable_count"] = open_profitable
            results["open_win_rate"] = open_profitable / open_can_buy_total
            results["avg_open_profit"] = sum(open_profits) / len(open_profits) if open_profits else 0

        if results["total_stocks"] >= min_sample:
            results["close_profitable_count"] = close_profitable
            results["close_win_rate"] = close_profitable / results["total_stocks"]
            results["avg_close_profit"] = sum(close_profits) / len(close_profits) if close_profits else 0

        # 生成结论
        results["conclusion"] = self._generate_conclusion(results)

        return results

    def _generate_conclusion(self, stats: Dict) -> str:
        """生成统计结论"""
        lines = []

        if stats["total_days"] > 0:
            lines.append(f"共统计 {stats['total_days']} 个交易日，{stats['total_stocks']} 只涨停股")

        if stats.get("open_can_buy_total", 0) > 0:
            open_wr = stats["open_win_rate"] * 100
            open_avg = stats.get("avg_open_profit", 0)
            lines.append(f"开盘买入胜率: {open_wr:.1f}% ({stats['open_profitable_count']}/{stats['open_can_buy_total']})")
            lines.append(f"开盘平均盈利: {open_avg:+.2f}%")

        if stats.get("close_win_rate"):
            close_wr = stats["close_win_rate"] * 100
            close_avg = stats.get("avg_close_profit", 0)
            lines.append(f"收盘盈利胜率: {close_wr:.1f}% ({stats['close_profitable_count']}/{stats['total_stocks']})")
            lines.append(f"收盘平均盈利: {close_avg:+.2f}%")

        return "\n".join(lines) if lines else "数据不足，无法生成结论"

    def get_stats(self) -> Dict:
        """获取数据库统计信息"""
        db = self._load_db()
        days = db.get("days", {})
        total_days = len(days)
        total_stocks = sum(d.get("total_count", 0) for d in days.values())
        days_with_followup = sum(1 for d in days.values() if d.get("followup"))

        return {
            "db_path": self.db_path,
            "total_days": total_days,
            "total_stocks": total_stocks,
            "days_with_followup": days_with_followup,
            "first_date": min(days.keys()) if days else None,
            "last_date": max(days.keys()) if days else None,
            "last_updated": db.get("last_updated")
        }


def main():
    """命令行工具"""
    import argparse

    parser = argparse.ArgumentParser(description="涨停分析数据库工具")
    parser.add_argument("action", choices=["stats", "list", "get", "analyze", "test"],
                        help="操作: stats(统计), list(列表), get(获取日期), analyze(胜率分析), test(测试)")
    parser.add_argument("--date", help="日期 YYYY-MM-DD")

    args = parser.parse_args()
    db = LimitUpDB()

    if args.action == "stats":
        stats = db.get_stats()
        print("="*60)
        print("涨停数据库统计")
        print("="*60)
        print(f"数据库路径: {stats['db_path']}")
        print(f"总交易日数: {stats['total_days']}")
        print(f"总涨停股数: {stats['total_stocks']}")
        print(f"已跟踪数据: {stats['days_with_followup']} 天")
        print(f"数据范围: {stats['first_date']} ~ {stats['last_date']}")
        print(f"最后更新: {stats['last_updated']}")

    elif args.action == "list":
        days = db.get_all_days()
        print("已记录的日期:")
        for d in days:
            day = db.get_day(d)
            count = day.get("total_count", 0) if day else 0
            has_followup = bool(day.get("followup")) if day else False
            tag = "✓" if has_followup else ""
            print(f"  {d}: {count}只涨停 {tag}")

    elif args.action == "get":
        if not args.date:
            print("需要指定 --date 参数")
            return
        day = db.get_day(args.date)
        if day:
            print(f"{args.date} 涨停数据:")
            print(f"  总数: {day['total_count']}只")
            print(f"  主板: {day.get('main_board_count', 0)}只")
            print(f"  科创板: {day.get('chip_board_count', 0)}只")
            print(f"  股票列表:")
            for s in day.get("stocks", [])[:10]:
                print(f"    {s['code']} {s['name']}: {s['change_pct']}%")
        else:
            print(f"无 {args.date} 的数据")

    elif args.action == "analyze":
        results = db.analyze_win_rate()
        print("="*60)
        print("涨停胜率分析")
        print("="*60)
        print(results["conclusion"])

    elif args.action == "test":
        # 测试数据
        from datetime import timedelta
        test_date = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

        test_stocks = [
            {
                "code": "002361",
                "name": "神剑股份",
                "change_pct": 10.0,
                "turnover": 5.4,
                "sealed_amount": 836000000,
                "float_cap_yi": 110.36,
                "is_chip": False,
                "open_gap": 2.5,
                "can_buy": True,
                "prev_close": 12.40,
                "open_price": 12.71,
                "score": 85,
                "level": "B+"
            },
            {
                "code": "688068",
                "name": "热景生物",
                "change_pct": 20.0,
                "turnover": 5.77,
                "sealed_amount": 115000000,
                "float_cap_yi": 1.2,
                "is_chip": True,
                "open_gap": 0.4,
                "can_buy": True,
                "prev_close": 40.83,
                "open_price": 41.00,
                "score": 82,
                "level": "B"
            }
        ]

        print(f"保存测试数据: {test_date}")
        db.save_day(test_date, test_stocks)

        # 测试跟踪数据
        followup_stocks = [
            {
                "code": "002361",
                "name": "神剑股份",
                "prev_close": 12.40,
                "next_open": 12.71,
                "next_close": 13.20,
                "next_pct": 6.45,
                "open_profit": (12.71 - 12.40) / 12.40 * 100,
                "close_profit": (13.20 - 12.40) / 12.40 * 100,
                "can_buy": True
            },
            {
                "code": "688068",
                "name": "热景生物",
                "prev_close": 40.83,
                "next_open": 41.00,
                "next_close": 40.10,
                "next_pct": -1.79,
                "open_profit": (41.00 - 40.83) / 40.83 * 100,
                "close_profit": (40.10 - 40.83) / 40.83 * 100,
                "can_buy": True
            }
        ]

        followup_date = datetime.now().strftime("%Y-%m-%d")
        db.add_follow_up(test_date, followup_date, followup_stocks)

        print("测试数据保存成功!")

        # 显示胜率分析
        results = db.analyze_win_rate()
        print("\n胜率分析:")
        print(results["conclusion"])


if __name__ == "__main__":
    main()
