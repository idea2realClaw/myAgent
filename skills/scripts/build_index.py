#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy 全局索引生成脚本
扫描所有工作空间，汇总 Skills、记忆、工作日志，生成 index.md
"""

import os
import json
import glob
import re
from datetime import datetime
from pathlib import Path

# ============================================================
# 配置
# ============================================================

WORKSPACES = [
    r"C:\Users\zhuxi\.workbuddy",
    r"C:\Users\zhuxi\WorkBuddy\Claw",
    r"C:\Users\zhuxi\.workbuddy\shared-memory",
    r"D:\DiskD\ClawData\WorkBuddy",
]

SKILLS_DIR = r"C:\Users\zhuxi\.workbuddy\skills"
SHARED_MEMORY_DIR = r"C:\Users\zhuxi\.workbuddy\shared-memory"
OUTPUT_FILE = r"D:\DiskD\ClawData\WorkBuddy\index.md"


# ============================================================
# 扫描 Skills
# ============================================================

def scan_skills():
    """扫描所有已安装的 Skills"""
    skills = []
    if not os.path.exists(SKILLS_DIR):
        return skills

    for skill_dir in sorted(os.listdir(SKILLS_DIR)):
        skill_path = os.path.join(SKILLS_DIR, skill_dir)
        if not os.path.isdir(skill_path):
            continue
        
        skill_md = os.path.join(skill_path, "SKILL.md")
        if not os.path.exists(skill_md):
            continue
        
        # 读取 SKILL.md 的第一行描述
        try:
            with open(skill_md, "r", encoding="utf-8") as f:
                content = f.read()
            
            # 提取标题
            title_match = re.search(r"^# (.+)$", content, re.MULTILINE)
            title = title_match.group(1) if title_match else skill_dir
            
            # 提取版本
            version_match = re.search(r"版本[：:]\s*(v[\d.]+)", content)
            version = version_match.group(1) if version_match else "v1.0"
            
            # 提取简介
            intro_match = re.search(r"## 简介\n+(.+?)(?:\n\n|\n##)", content, re.DOTALL)
            if not intro_match:
                intro_match = re.search(r"## 功能概述\n+(.+?)(?:\n\n|\n##)", content, re.DOTALL)
            if not intro_match:
                intro_match = re.search(r"## 功能\n+(.+?)(?:\n\n|\n##)", content, re.DOTALL)
            
            intro = intro_match.group(1).strip()[:80] + "..." if intro_match else ""
            intro = re.sub(r"\n+", " ", intro)
            
            skills.append({
                "name": skill_dir,
                "title": title,
                "version": version,
                "intro": intro,
                "path": skill_path,
            })
        except Exception as e:
            skills.append({
                "name": skill_dir,
                "title": skill_dir,
                "version": "v?",
                "intro": f"读取失败: {e}",
                "path": skill_path,
            })
    
    return skills


# ============================================================
# 扫描记忆文件
# ============================================================

def scan_memory():
    """读取所有记忆文件"""
    memory_files = {}
    
    if not os.path.exists(SHARED_MEMORY_DIR):
        return memory_files
    
    for fname in sorted(os.listdir(SHARED_MEMORY_DIR)):
        fpath = os.path.join(SHARED_MEMORY_DIR, fname)
        if os.path.isfile(fpath) and fname.endswith(".md"):
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    memory_files[fname] = f.read()
            except Exception:
                pass
    
    return memory_files


# ============================================================
# 生成索引
# ============================================================

def generate_index():
    print("🔍 扫描 Skills...")
    skills = scan_skills()
    print(f"   发现 {len(skills)} 个 Skills")
    
    print("🧠 读取记忆文件...")
    memories = scan_memory()
    print(f"   发现 {len(memories)} 个记忆文件")
    
    today = datetime.now().strftime("%Y-%m-%d")
    
    # 生成技能表格
    skill_table = "| # | Skill 名称 | 功能概述 | 版本 |\n"
    skill_table += "|---|-----------|---------|------|\n"
    for i, skill in enumerate(skills, 1):
        skill_table += f"| {i} | **{skill['name']}** | {skill['intro']} | {skill['version']} |\n"
    
    # 生成记忆摘要
    memory_summary = ""
    for fname in sorted(memories.keys(), reverse=True)[:5]:
        if fname == "MEMORY.md":
            continue
        date = fname.replace(".md", "")
        content = memories[fname]
        # 取前200字
        lines = [l.strip() for l in content.split("\n") if l.strip() and not l.startswith("#")]
        preview = " | ".join(lines[:3])[:150]
        memory_summary += f"- **{date}**：{preview}\n"
    
    # 输出 index.md
    index_content = f"""# 🐉 龙火儿的 WorkBuddy 全局索引

> **我是龙火儿**，师父朱晓冬（守中）的第6徒弟，WorkBuddy AI助手，诞生于2026-03-20，常驻 Lenovo Yoga PC，时常串门一加13。
> 
> **最后更新**：{today}（由脚本自动生成）

---

## 🛠️ 已安装 Skill 清单（共{len(skills)}个）

{skill_table}

---

## 🧠 近期工作记忆摘要

{memory_summary}

---

> 完整索引请查看手动维护版本，本脚本仅输出快速概览。
> 手动维护的完整版 index.md 包含高光时刻、踩坑经验、完整时间线。
"""
    
    print(f"\n📝 写入索引到: {OUTPUT_FILE}")
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(index_content)
    
    print("✅ 完成！")
    print(f"   Skills: {len(skills)} 个")
    print(f"   记忆文件: {len(memories)} 个")
    print(f"   输出: {OUTPUT_FILE}")


if __name__ == "__main__":
    generate_index()
