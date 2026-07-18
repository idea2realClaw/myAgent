#!/usr/bin/env python3
"""
proofread.py - 智能校对模块
按段落读取 OCR 文本，通过 LLM 重写为通顺、准确的文字

依赖：pip3 install requests
环境变量：OPENAI_API_KEY（必填）
可选环境变量：OPENAI_BASE_URL（默认 https://api.openai.com/v1）
可选环境变量：OPENAI_MODEL（默认 gpt-4o-mini）
"""

import os
import sys
import re
import argparse
import requests
from typing import List, Tuple

# ── LLM 配置 ────────────────────────────────────────────────
API_KEY = os.environ.get("OPENAI_API_KEY", "")
BASE_URL = os.environ.get(
    "OPENAI_BASE_URL", "https://api.openai.com/v1"
).rstrip("/")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

# ── 系统提示词 ───────────────────────────────────────────────
SYSTEM_PROMPT = """你是一位专业的中文校对专家。你的任务是根据OCR识别的原始文本，重新整理校对，输出通顺、准确、意思与原文一致的精校文本。

校对规则：
1. 纠正OCR识别错误（如"分暴"→"分鬃"，"吃"→"屹"，"RAR"等乱码）
2. 纠正错别字，保持原意
3. 调整语句使其通顺流畅，符合中文表达习惯
4. 保留原文的专有名词（人名、地名、招式名等）
5. 保留原有段落结构
6. 如果原文意思模糊，在不臆测的前提下尽量还原合理内容
7. 如果原文是古文/拳谱歌诀，尽量保持原貌，只纠正明显OCR错误
8. 不要添加原文没有的内容，不要脑补解释
9. 输出的文本应该纯正文，不要加"校对后："等前缀
10. 只输出校对后的正文，不要输出任何说明

输出格式：
- 直接输出校对后的文本
- 保持原有段落分隔
"""

# ── LLM 调用 ────────────────────────────────────────────────
def call_llm(text: str, api_key: str = "", base_url: str = "", model: str = "") -> str:
    """调用 LLM 重写文本"""
    key = api_key or API_KEY
    url = (base_url or BASE_URL) + "/chat/completions"
    mdl = model or MODEL

    if not key:
        raise ValueError(
            "请设置环境变量 OPENAI_API_KEY，或通过参数传入 API Key。\n"
            "例如：OPENAI_API_KEY=sk-xxx python3 proofread.py input.txt"
        )

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": mdl,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "temperature": 0.3,
        "max_tokens": 8192,
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    except requests.exceptions.HTTPError as e:
        err_detail = ""
        try:
            err_detail = resp.json().get("error", {}).get("message", "")
        except Exception:
            pass
        raise RuntimeError(f"LLM API 错误: {e}\n详情: {err_detail}")
    except Exception as e:
        raise RuntimeError(f"LLM 调用失败: {e}")


# ── 文本分块 ────────────────────────────────────────────────
def split_into_chunks(text: str, chunk_size: int = 3500) -> List[str]:
    """
    按段落智能分块，每块不超过 chunk_size 个字符。
    优先在段落边界切分，避免切断句子。
    """
    # 先按"=== 第 X 页 ==="拆成页面级块
    page_blocks = re.split(r"(?==== 第 \d+ 页)", text)

    chunks = []
    current = ""

    for block in page_blocks:
        if not block.strip():
            continue

        # 如果单页就超过 chunk_size，按句子继续切
        if len(block) > chunk_size:
            if current.strip():
                chunks.append(current.strip())
                current = ""

            # 按句子切（。！？；\n）
            sentences = re.split(r"(?<=[。！？；\n])\s*", block)
            local = ""
            for s in sentences:
                if len(local) + len(s) <= chunk_size:
                    local += s + "\n"
                else:
                    if local.strip():
                        chunks.append(local.strip())
                    local = s + "\n"
            if local.strip():
                chunks.append(local.strip())
        else:
            if len(current) + len(block) <= chunk_size:
                current += block + "\n"
            else:
                if current.strip():
                    chunks.append(current.strip())
                current = block + "\n"

    if current.strip():
        chunks.append(current.strip())

    return chunks


# ── 逐块校对 ────────────────────────────────────────────────
def proofread_file(
    input_path: str,
    output_path: str = "",
    api_key: str = "",
    base_url: str = "",
    model: str = "",
    chunk_size: int = 3500,
    dry_run: bool = False,
) -> str:
    """
    读取 OCR 文本文件，分块校对，输出精校文本。
    返回输出文件路径。
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"文件不存在: {input_path}")

    with open(input_path, "r", encoding="utf-8") as f:
        raw_text = f.read()

    if not raw_text.strip():
        raise ValueError("输入文件为空")

    # 生成输出路径
    if not output_path:
        base = os.path.splitext(input_path)[0]
        output_path = f"{base}_校对版.txt"

    print(f"\n📖 读取完成: {len(raw_text)} 字符")
    print(f"📤 输出路径: {output_path}")

    # 分块
    chunks = split_into_chunks(raw_text, chunk_size)
    print(f"📦 分块数量: {len(chunks)} 块（每块 ~{chunk_size} 字符）")
    print()

    if dry_run:
        print(f"[Dry Run] 第 1 块预览（仅处理第 1 块）：")
        preview = call_llm(chunks[0], api_key, base_url, model)
        print(preview[:500])
        return output_path

    # 逐块校对
    proved_texts: List[str] = []
    total = len(chunks)

    for i, chunk in enumerate(chunks, 1):
        char_count = len(chunk)
        print(f"  [{i}/{total}] 校对中... ({char_count} 字)")

        proved = call_llm(chunk, api_key, base_url, model)
        proved = proved.strip()
        proved_texts.append(proved)

        print(f"       ✅ 完成 ({len(proved)} 字)")

    # 合并输出
    final_text = "\n\n".join(proved_texts)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(final_text)

    print(f"\n✅ 校对完成！共处理 {total} 块，输出 {len(final_text)} 字符")
    print(f"📁 {output_path}")

    return output_path


# ── CLI 入口 ────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="智能校对 OCR 文本：通过 LLM 重写为通顺、准确的文字",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 使用环境变量中的 API Key
  OPENAI_API_KEY=sk-xxx python3 proofread.py input.txt

  # 指定 API Key 和模型
  python3 proofread.py input.txt -k sk-xxx -m gpt-4o

  # 指定输出文件名
  python3 proofread.py input.txt -o proofread_output.txt

  # 预览模式（只处理第一块）
  python3 proofread.py input.txt --dry-run

  # 自定义 API 端点（如硅基流动等）
  OPENAI_BASE_URL=https://api.siliconflow.cn/v1 OPENAI_API_KEY=xxx \\
    python3 proofread.py input.txt
""",
    )
    parser.add_argument("input", help="输入的 OCR 文本文件（.txt）")
    parser.add_argument(
        "-o", "--output", default="", help="输出文件路径（默认：原名_校对版.txt）"
    )
    parser.add_argument(
        "-k", "--api-key", default="", help="LLM API Key（也可设置环境变量 OPENAI_API_KEY）"
    )
    parser.add_argument(
        "-b", "--base-url", default="", help="API 端点（默认：https://api.openai.com/v1）"
    )
    parser.add_argument(
        "-m", "--model", default="", help="模型名称（默认：gpt-4o-mini）"
    )
    parser.add_argument(
        "-c", "--chunk-size", type=int, default=3500,
        help="每块字符数（默认：3500，不建议超过 4000）"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="预览模式，只校对第一块并打印结果"
    )

    args = parser.parse_args()

    # 检查 API Key
    key = args.api_key or os.environ.get("OPENAI_API_KEY", "")
    if not key and not args.dry_run:
        print("❌ 错误：请设置 OPENAI_API_KEY 环境变量，或通过 -k 参数传入")
        print()
        print("快速设置：")
        print("  export OPENAI_API_KEY='sk-xxx'   # macOS/Linux")
        print("  set OPENAI_API_KEY=sk-xxx         # Windows")
        print()
        print("或使用命令行参数：")
        print("  python3 proofread.py input.txt -k sk-xxx")
        sys.exit(1)

    try:
        output_path = proofread_file(
            input_path=args.input,
            output_path=args.output,
            api_key=key,
            base_url=args.base_url,
            model=args.model,
            chunk_size=args.chunk_size,
            dry_run=args.dry_run,
        )
        print(f"\n🎉 完成！校对结果已保存到：{output_path}")
    except FileNotFoundError as e:
        print(f"❌ 文件错误: {e}")
        sys.exit(1)
    except ValueError as e:
        print(f"❌ 错误: {e}")
        sys.exit(1)
    except RuntimeError as e:
        print(f"❌ LLM 错误: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n⚠️  已中断")
        sys.exit(130)


if __name__ == "__main__":
    main()
