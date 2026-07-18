#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy 全局索引生成脚本 v2.0 (跨平台增强版)
支持 macOS 和 Windows，自动检测系统类型并扫描对应目录
"""

import os
import sys
import re
import platform
import subprocess
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional

# ============================================================
# 跨平台路径检测
# ============================================================

def get_platform() -> str:
    """检测操作系统类型"""
    system = platform.system().lower()
    if system == "darwin":
        return "macos"
    elif system == "windows":
        return "windows"
    elif system == "linux":
        return "linux"
    else:
        return system


def get_user_home() -> str:
    """获取用户主目录"""
    return str(Path.home())


def expand_path(path: str) -> str:
    """展开路径中的环境变量和~"""
    path = os.path.expanduser(path)
    path = os.path.expandvars(path)
    return path


# ============================================================
# 平台特定配置
# ============================================================

def get_platform_config() -> Dict:
    """根据操作系统返回对应的配置"""
    p = get_platform()
    home = get_user_home()
    
    if p == "macos":
        # macOS 典型配置
        config = {
            "user_name": os.environ.get("USER", "Unknown"),
            "user_tz": "Asia/Shanghai",
            "home": home,
            "skills_dir": f"{home}/.workbuddy/skills",
            "memory_dir": f"{home}/ClawData/WorkBuddy/.workbuddy/memory",
            "workbuddy_root": f"{home}/ClawData/WorkBuddy",
            "workbuddy_alt": f"{home}/WorkBuddy",
            "documents_git": f"{home}/Documents/GitRepo",
            "index_output": f"{home}/ClawData/WorkBuddy/index.md",
            "index_alt": f"{home}/WorkBuddy/index.md",
        }
    elif p == "windows":
        # Windows 典型配置
        user = os.environ.get("USERNAME", os.environ.get("USER", "Unknown"))
        config = {
            "user_name": user,
            "user_tz": "Asia/Shanghai",
            "home": home,
            "skills_dir": f"{home}\\.workbuddy\\skills",
            "memory_dir": f"{home}\\.workbuddy\\shared-memory",
            "workbuddy_root": f"{home}\\WorkBuddy\\Claw",
            "workbuddy_alt": f"{home}\\WorkBuddy",
            "documents_git": f"{home}\\Documents\\GitRepo",
            "index_output": f"{home}\\WorkBuddy\\Claw\\index.md",
            "index_alt": None,
        }
        # 尝试常见 Windows 路径
        for alt_disk in ["D:", "E:"]:
            alt_path = f"{alt_disk}\\DiskD\\ClawData\\WorkBuddy"
            if os.path.exists(alt_path):
                config["workbuddy_root"] = alt_path
                config["index_output"] = f"{alt_path}\\index.md"
                break
    else:
        # Linux / 其他
        config = {
            "user_name": os.environ.get("USER", "Unknown"),
            "user_tz": "Asia/Shanghai",
            "home": home,
            "skills_dir": f"{home}/.workbuddy/skills",
            "memory_dir": f"{home}/.workbuddy/memory",
            "workbuddy_root": f"{home}/ClawData/WorkBuddy",
            "workbuddy_alt": f"{home}/WorkBuddy",
            "documents_git": f"{home}/Documents/GitRepo",
            "index_output": f"{home}/ClawData/WorkBuddy/index.md",
            "index_alt": None,
        }
    
    return config


# ============================================================
# 目录扫描
# ============================================================

def find_all_workbuddy_dirs() -> List[str]:
    """递归查找所有 .workbuddy 目录"""
    home = get_user_home()
    workbuddy_dirs = set()
    
    # 常见搜索路径
    search_paths = [
        home,
        f"{home}/ClawData",
        f"{home}/WorkBuddy",
        f"{home}/Documents",
        f"{home}/Downloads",
    ]
    
    if get_platform() == "windows":
        search_paths.extend([
            f"{home}/WorkBuddy",
            "D:\\DiskD\\ClawData",
        ])
    
    for base in search_paths:
        if not os.path.exists(base):
            continue
        try:
            for root, dirs, files in os.walk(base):
                # 跳过 node_modules 和 .git
                dirs[:] = [d for d in dirs if d not in ['node_modules', '.git', '__pycache__']]
                
                if '.workbuddy' in dirs or '.workbuddy' in root.split(os.sep):
                    workbuddy_dir = os.path.join(root, '.workbuddy') if '.workbuddy' not in root else root
                    if os.path.isdir(workbuddy_dir):
                        workbuddy_dirs.add(workbuddy_dir)
                        
                # 也查找直接包含 index.md 或 skills/ 的目录
                if 'index.md' in files or 'skills' in dirs:
                    if 'ClawData' in root or 'WorkBuddy' in root:
                        workbuddy_dirs.add(root)
        except PermissionError:
            continue
        except Exception:
            continue
    
    return sorted(list(workbuddy_dirs))


def find_all_skills_dirs() -> List[str]:
    """查找所有 Skills 目录"""
    skills_dirs = set()
    
    # 标准路径
    config = get_platform_config()
    standard_skills = config.get("skills_dir")
    if standard_skills and os.path.isdir(standard_skills):
        skills_dirs.add(standard_skills)
    
    # 查找所有 .workbuddy/skills
    for wb_dir in find_all_workbuddy_dirs():
        skills_in_wb = os.path.join(wb_dir, "skills")
        if os.path.isdir(skills_in_wb) and skills_in_wb not in skills_dirs:
            skills_dirs.add(skills_in_wb)
    
    return sorted(list(skills_dirs))


def find_all_memory_dirs() -> List[str]:
    """查找所有记忆目录"""
    memory_dirs = set()
    
    config = get_platform_config()
    
    # 标准路径
    standard_memory = config.get("memory_dir")
    if standard_memory and os.path.isdir(standard_memory):
        memory_dirs.add(standard_memory)
    
    # 查找所有 .workbuddy/memory 或 shared-memory
    for wb_dir in find_all_workbuddy_dirs():
        for mem_name in ["memory", "shared-memory"]:
            mem_dir = os.path.join(wb_dir, mem_name)
            if os.path.isdir(mem_dir) and mem_dir not in memory_dirs:
                memory_dirs.add(mem_dir)
    
    return sorted(list(memory_dirs))


def find_workbuddy_workspaces() -> List[Dict]:
    """查找所有 WorkBuddy 工作空间"""
    workspaces = []
    
    # 常见根目录
    roots = [
        f"{get_user_home()}/ClawData/WorkBuddy",
        f"{get_user_home()}/WorkBuddy",
    ]
    
    if get_platform() == "windows":
        roots.extend([
            f"{get_user_home()}\\WorkBuddy\\Claw",
            "D:\\DiskD\\ClawData\\WorkBuddy",
        ])
    
    for root in roots:
        if not os.path.exists(root):
            continue
        
        # 查找数字命名的目录（工作空间格式）
        for item in os.listdir(root):
            item_path = os.path.join(root, item)
            if os.path.isdir(item_path):
                # 检查是否是工作空间（通常包含 .workbuddy 子目录或特定文件）
                if re.match(r'^\d{14}$', item) or item.startswith('automation-'):
                    mtime = os.path.getmtime(item_path)
                    workspaces.append({
                        "name": item,
                        "path": item_path,
                        "mtime": mtime,
                        "date": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d")
                    })
    
    # 按修改时间排序
    workspaces.sort(key=lambda x: x["mtime"], reverse=True)
    return workspaces


# ============================================================
# Skills 扫描
# ============================================================

def scan_skills(skills_dir: str) -> List[Dict]:
    """扫描指定目录下的所有 Skills"""
    skills = []
    
    if not os.path.isdir(skills_dir):
        return skills
    
    for skill_name in sorted(os.listdir(skills_dir)):
        skill_path = os.path.join(skills_dir, skill_name)
        if not os.path.isdir(skill_path):
            continue
        
        skill_md = os.path.join(skill_path, "SKILL.md")
        if not os.path.exists(skill_md):
            continue
        
        try:
            with open(skill_md, "r", encoding="utf-8") as f:
                content = f.read()
            
            # 提取标题（第一行 # ）
            title_match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
            title = title_match.group(1).strip() if title_match else skill_name
            
            # 提取版本
            version_match = re.search(r"版本[：:]\s*(v[\d.]+)", content)
            version = version_match.group(1) if version_match else "v1.0"
            
            # 提取简介
            intro = ""
            for pattern in [r"## 功能概述\n+(.+?)(?:\n\n|\n##)", 
                           r"## 简介\n+(.+?)(?:\n\n|\n##)",
                           r"## 功能\n+(.+?)(?:\n\n|\n##)"]:
                intro_match = re.search(pattern, content, re.DOTALL)
                if intro_match:
                    intro = intro_match.group(1).strip()
                    intro = re.sub(r"\n+", " ", intro)
                    intro = intro[:100] + "..." if len(intro) > 100 else intro
                    break
            
            # 提取描述中的触发词
            trigger_match = re.search(r"触发[词词：:]\s*(.+?)(?:\n|##|$)", content, re.DOTALL)
            triggers = trigger_match.group(1).strip()[:60] if trigger_match else ""
            
            # 统计脚本数量
            scripts_count = 0
            scripts_dir = os.path.join(skill_path, "scripts")
            if os.path.isdir(scripts_dir):
                scripts_count = len([f for f in os.listdir(scripts_dir) if os.path.isfile(os.path.join(scripts_dir, f))])
            
            skills.append({
                "name": skill_name,
                "title": title,
                "version": version,
                "intro": intro,
                "triggers": triggers,
                "scripts_count": scripts_count,
                "path": skill_path,
            })
        except Exception as e:
            skills.append({
                "name": skill_name,
                "title": skill_name,
                "version": "v?",
                "intro": f"读取失败: {e}",
                "triggers": "",
                "scripts_count": 0,
                "path": skill_path,
            })
    
    return skills


# ============================================================
# 记忆文件扫描
# ============================================================

def scan_memory_files(memory_dir: str, limit: int = 10) -> List[Dict]:
    """扫描记忆文件"""
    memories = []
    
    if not os.path.isdir(memory_dir):
        return memories
    
    for fname in sorted(os.listdir(memory_dir)):
        if not fname.endswith(".md"):
            continue
        
        fpath = os.path.join(memory_dir, fname)
        if not os.path.isfile(fpath):
            continue
        
        try:
            mtime = os.path.getmtime(fpath)
            size = os.path.getsize(fpath)
            
            with open(fpath, "r", encoding="utf-8") as f:
                content = f.read()
            
            # 提取前几行作为预览
            lines = [l.strip() for l in content.split("\n") if l.strip() and not l.startswith("#")]
            preview = " | ".join(lines[:3])[:150] if lines else "（空文件）"
            
            memories.append({
                "name": fname,
                "path": fpath,
                "date": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d"),
                "size": size,
                "preview": preview,
            })
        except Exception:
            continue
    
    # 按日期倒序
    memories.sort(key=lambda x: x["date"], reverse=True)
    return memories[:limit]


# ============================================================
# 项目扫描
# ============================================================

def scan_projects() -> List[Dict]:
    """扫描 GitRepo 目录下的项目"""
    projects = []
    
    config = get_platform_config()
    gitrepo = config.get("documents_git", f"{get_user_home()}/Documents/GitRepo")
    
    if not os.path.isdir(gitrepo):
        return projects
    
    for item in os.listdir(gitrepo):
        item_path = os.path.join(gitrepo, item)
        if not os.path.isdir(item_path):
            continue
        
        # 检查是否是 Git 仓库
        is_git = os.path.isdir(os.path.join(item_path, ".git"))
        
        # 查找 README
        readme = None
        for rn in ["README.md", "README.txt", "README"]:
            readme_path = os.path.join(item_path, rn)
            if os.path.exists(readme_path):
                readme = rn
                break
        
        projects.append({
            "name": item,
            "path": item_path,
            "is_git": is_git,
            "readme": readme,
        })
    
    return projects


# ============================================================
# 生成索引
# ============================================================

def generate_index():
    """生成完整的全局索引"""
    config = get_platform_config()
    p = get_platform()
    
    print(f"\n{'='*60}")
    print(f"🐉 WorkBuddy 全局索引生成器 v2.0")
    print(f"{'='*60}")
    print(f"📌 平台检测: {p.upper()}")
    print(f"📌 用户: {config['user_name']}")
    print(f"📌 主目录: {config['home']}")
    print()
    
    # 1. 扫描所有 Skills
    print("🔍 扫描 Skills...")
    all_skills = []
    skills_dirs = find_all_skills_dirs()
    print(f"   发现 {len(skills_dirs)} 个 Skills 目录")
    
    for sd in skills_dirs:
        skills = scan_skills(sd)
        all_skills.extend(skills)
        if skills:
            print(f"   • {sd}: {len(skills)} 个")
    
    print(f"   ✅ 共发现 {len(all_skills)} 个 Skills")
    
    # 2. 扫描记忆文件
    print("\n🧠 扫描记忆文件...")
    all_memories = []
    memory_dirs = find_all_memory_dirs()
    print(f"   发现 {len(memory_dirs)} 个记忆目录")
    
    for md in memory_dirs:
        memories = scan_memory_files(md)
        all_memories.extend(memories)
        if memories:
            print(f"   • {md}: {len(memories)} 个")
    
    print(f"   ✅ 共发现 {len(all_memories)} 个记忆文件")
    
    # 3. 扫描工作空间
    print("\n📁 扫描工作空间...")
    workspaces = find_workbuddy_workspaces()
    print(f"   ✅ 共发现 {len(workspaces)} 个工作空间")
    
    # 4. 扫描项目
    print("\n💻 扫描 GitRepo 项目...")
    projects = scan_projects()
    print(f"   ✅ 共发现 {len(projects)} 个项目")
    
    # 5. 扫描 .workbuddy 目录
    print("\n🔎 深度扫描 .workbuddy 目录...")
    all_workbuddy_dirs = find_all_workbuddy_dirs()
    print(f"   ✅ 共发现 {len(all_workbuddy_dirs)} 个相关目录")
    
    today = datetime.now().strftime("%Y-%m-%d %H:%M")
    
    # ============================================================
    # 生成 index.md 内容
    # ============================================================
    
    # Skills 表格
    skill_table = "| # | Skill 名称 | 功能概述 | 版本 | 脚本数 |\n"
    skill_table += "|---|-----------|---------|------|------|\n"
    for i, skill in enumerate(all_skills, 1):
        skill_table += f"| {i} | **{skill['name']}** | {skill['intro'][:50]} | {skill['version']} | {skill['scripts_count']} |\n"
    
    # 记忆摘要
    memory_summary = ""
    for mem in all_memories[:10]:
        memory_summary += f"- **{mem['date']}** [{mem['name']}](file://{mem['path']})：{mem['preview']}\n"
    
    # 工作空间列表
    workspace_list = "| 目录名 | 路径 | 修改日期 |\n"
    workspace_list += "|------|------|----------|\n"
    for ws in workspaces[:20]:
        workspace_list += f"| `{ws['name']}` | {ws['path']} | {ws['date']} |\n"
    if len(workspaces) > 20:
        workspace_list += f"| ... | 还有 {len(workspaces) - 20} 个 | - |\n"
    
    # 项目列表
    project_list = "| 项目名 | 类型 | 备注 |\n"
    project_list += "|------|------|------|\n"
    for proj in projects:
        proj_type = "📦 Git" if proj['is_git'] else "📁 普通"
        proj_note = f"README: {proj['readme']}" if proj['readme'] else ""
        project_list += f"| {proj['name']} | {proj_type} | {proj_note} |\n"
    
    # Skills 目录来源
    skills_sources = "| # | 来源目录 | 数量 |\n"
    skills_sources += "|---|---------|------|\n"
    for i, sd in enumerate(skills_dirs, 1):
        count = len([s for s in all_skills if s['path'].startswith(sd)])
        short_path = sd.replace(get_user_home(), "~")
        skills_sources += f"| {i} | `{short_path}` | {count} |\n"
    
    index_content = f"""# 🐉 龙木心的 WorkBuddy 全局索引

> **身份**：龙木心（Longmuxin），师父朱晓冬（守中/知常公子）的第5徒弟
> 
> **平台**：{p.upper()} | **用户**：{config['user_name']} | **主目录**：`{config['home']}`
>
> **最后更新**：{today}

---

## 📊 索引统计

| 项目 | 数量 |
|------|------|
| Skills | {len(all_skills)} 个 |
| 记忆文件 | {len(all_memories)} 个 |
| 工作空间 | {len(workspaces)} 个 |
| GitRepo 项目 | {len(projects)} 个 |
| .workbuddy 相关目录 | {len(all_workbuddy_dirs)} 个 |

---

## 🛠️ 已安装 Skills 清单（共 {len(all_skills)} 个）

{skill_table}

### Skills 来源分布

{skills_sources}

---

## 📁 工作空间列表（共 {len(workspaces)} 个）

{workspace_list}

---

## 💻 GitRepo 项目（共 {len(projects)} 个）

{project_list}

---

## 🧠 记忆文件摘要（共 {len(all_memories)} 个）

{memory_summary}

---

## 📂 .workbuddy 相关目录

```
{chr(10).join(all_workbuddy_dirs[:30])}
```

---

## 🔄 索引生成信息

| 项目 | 内容 |
|------|------|
| 生成时间 | {today} |
| 脚本版本 | v2.0 跨平台增强版 |
| 平台 | {p.upper()} |
| Skills 目录数 | {len(skills_dirs)} |
| 记忆目录数 | {len(memory_dirs)} |

---

> 📍 本索引由 `workbuddy-index` Skill 自动生成
> 🐉 龙木心出品 | {today}
"""
    
    # 写入索引文件
    output_file = config["index_output"]
    
    # 确保目录存在
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(index_content)
    
    print(f"\n{'='*60}")
    print(f"✅ 全局索引生成完成！")
    print(f"{'='*60}")
    print(f"📄 输出文件: {output_file}")
    print(f"📊 Skills: {len(all_skills)} 个")
    print(f"📁 工作空间: {len(workspaces)} 个")
    print(f"🧠 记忆文件: {len(all_memories)} 个")
    print(f"💻 GitRepo 项目: {len(projects)} 个")
    print()
    
    return output_file


# ============================================================
# 入口
# ============================================================

if __name__ == "__main__":
    if len(sys.argv) > 1:
        if sys.argv[1] in ["-h", "--help"]:
            print("""
WorkBuddy 全局索引生成器 v2.0

用法:
    python3 build_index.py          # 生成索引
    python3 build_index.py --help   # 显示帮助

功能:
    - 自动检测 macOS/Windows/Linux 平台
    - 扫描所有 .workbuddy 目录
    - 汇总 Skills、记忆、工作空间
    - 生成完整的 index.md
""")
            sys.exit(0)
    
    output = generate_index()
    print(f"\n💡 提示: 索引文件已生成，可以分享给师门其他徒弟")
