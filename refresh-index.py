#!/usr/bin/env python3
"""
从飞书知识库拉取所有页面的元数据，重建本地索引文件 .feishu-index.json

用法：
  python3 refresh-index.py              # 重建索引
  python3 refresh-index.py --verbose    # 显示详细过程

索引文件是"飞书为主"架构的本地缓存，用于 Claude 在操作前快速查找页面。
所有写操作完成后也应更新本地索引（由 feishu_wiki.py 辅助库负责）。
"""

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

INDEX_FILE = Path(".feishu-index.json")
CATEGORIES = ["来源", "主题", "实体", "综合"]

VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv


def log(msg):
    if VERBOSE:
        print(msg)


def run_lark(args):
    """执行 lark-cli，返回 JSON。"""
    result = subprocess.run(["lark-cli"] + args, capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        if result.stderr:
            print(f"  [stderr] {result.stderr[:300]}", file=sys.stderr)
        return None


def load_index():
    """加载现有索引（如果存在），用于获取 space_id/root 这些基础信息。"""
    if INDEX_FILE.exists():
        return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    return None


def load_legacy_state():
    """从旧的 .feishu-sync.json 读取 space_id/root 等基础信息（迁移用）。"""
    legacy = Path(".feishu-sync.json")
    if legacy.exists():
        return json.loads(legacy.read_text(encoding="utf-8"))
    return None


def fetch_node_info(token):
    """查询单个节点的详细信息（obj_token、obj_type 等）。"""
    result = run_lark(
        [
            "wiki",
            "spaces",
            "get_node",
            "--as",
            "user",
            "--params",
            json.dumps({"token": token}),
        ]
    )
    if result and (result.get("ok") or result.get("code") == 0):
        return result.get("data", {}).get("node", {})
    return None


def _auto_discover_wiki_space():
    """
    首次运行时自动发现 AI Wiki 知识空间。

    策略：
      1. 列出当前用户的所有知识空间
      2. 找名字包含 "AI Wiki" 或 "AI 维基" 的空间
      3. 列出该空间的根级节点，找名为 "AI Wiki" 的 docx 节点作为 root

    返回 {"space_id": ..., "root_node_token": ..., "root_obj_token": ...} 或 None
    """
    # 1. 列出所有可访问的知识空间
    list_result = run_lark(
        [
            "wiki",
            "spaces",
            "list",
            "--as",
            "user",
            "--params",
            json.dumps({"page_size": 50}),
        ]
    )
    if not list_result or not (
        list_result.get("ok") or list_result.get("code") == 0
    ):
        return None

    spaces = list_result.get("data", {}).get("items", [])
    target_space = None
    for s in spaces:
        name = s.get("name", "")
        if "AI Wiki" in name or "AI 维基" in name or "AI维基" in name:
            target_space = s
            break
    if not target_space and spaces:
        # 只有一个空间时直接用
        if len(spaces) == 1:
            target_space = spaces[0]

    if not target_space:
        return None

    space_id = target_space.get("space_id")

    # 2. 列出空间根节点（parent_node_token 为空字符串表示根）
    nodes_result = run_lark(
        [
            "wiki",
            "nodes",
            "list",
            "--as",
            "user",
            "--params",
            json.dumps({"space_id": space_id, "page_size": 50}),
        ]
    )
    if not nodes_result or not (
        nodes_result.get("ok") or nodes_result.get("code") == 0
    ):
        return None

    root_nodes = nodes_result.get("data", {}).get("items", [])
    # 找名字为 "AI Wiki" 的 docx 节点；如果找不到，用第一个 docx
    ai_wiki_node = None
    for node in root_nodes:
        if node.get("title", "") in ("AI Wiki", "AI 维基", "AI维基") and node.get(
            "obj_type"
        ) == "docx":
            ai_wiki_node = node
            break
    if not ai_wiki_node:
        for node in root_nodes:
            if node.get("obj_type") == "docx":
                ai_wiki_node = node
                break

    if not ai_wiki_node:
        return None

    return {
        "space_id": space_id,
        "root_node_token": ai_wiki_node.get("node_token"),
        "root_obj_token": ai_wiki_node.get("obj_token"),
    }


def fetch_doc_markdown(doc_id):
    """拉取单个文档的 Markdown 正文。"""
    result = run_lark(
        ["docs", "+fetch", "--as", "user", "--doc", doc_id]
    )
    if result and (result.get("ok") or result.get("code") == 0):
        return result.get("data", {}).get("markdown", "")
    return ""


def extract_summary(markdown: str, max_len: int = 200) -> str:
    """
    从 Lark-flavored Markdown 中提取一段简短摘要。

    策略（从上到下依次尝试）：
      1. 第一个 "## 概述" / "## 核心要点" 章节下的第一段
      2. 第一个 H2 章节下的第一段
      3. 文档开头的第一个非空段落

    会清洗掉 markdown 格式（加粗、链接、mention-doc 等）。
    """
    import re

    if not markdown:
        return ""

    # 去掉开头的代码块（TOC）
    md = re.sub(r"^```[^\n]*\n.*?```\s*", "", markdown, count=1, flags=re.DOTALL)

    # 去掉 HTML 标签（lark-table、callout、mention-doc 等）
    def _clean_html(text):
        # 把 mention-doc 替换成它的显示文本
        text = re.sub(
            r'<mention-doc[^>]*>([^<]+)</mention-doc>', r"\1", text
        )
        # 去除其他 HTML 标签
        text = re.sub(r"<[^>]+>", "", text)
        return text

    # 优先找 概述 / 核心要点 章节
    priority_sections = ["概述", "核心要点", "Summary", "Overview"]
    for section in priority_sections:
        pattern = rf"##\s+{re.escape(section)}\s*\n+(.*?)(?=\n##\s|\Z)"
        match = re.search(pattern, md, re.DOTALL)
        if match:
            body = match.group(1).strip()
            return _first_paragraph(body, max_len, _clean_html)

    # 回退：任意第一个 H2 下的第一段
    h2_match = re.search(r"##\s+[^\n]+\n+(.*?)(?=\n##\s|\Z)", md, re.DOTALL)
    if h2_match:
        return _first_paragraph(h2_match.group(1).strip(), max_len, _clean_html)

    # 回退：文档开头第一段
    return _first_paragraph(md.strip(), max_len, _clean_html)


def _first_paragraph(text: str, max_len: int, cleaner) -> str:
    """从文本中提取第一段有意义的内容。"""
    import re

    # 处理 bullet 列表：合并前几个 bullet
    lines = text.split("\n")
    bullets = []
    for line in lines:
        line = line.strip()
        if line.startswith(("- ", "* ")):
            bullets.append(line[2:])
        elif bullets:
            break  # 列表结束
        elif line and not line.startswith("#"):
            # 非列表段落
            break

    if bullets:
        joined = "；".join(bullets[:3])
    else:
        # 取第一段（非空非标题行）
        paras = []
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                if paras:
                    break
                continue
            paras.append(line)
            if sum(len(p) for p in paras) > max_len:
                break
        joined = " ".join(paras)

    cleaned = cleaner(joined)
    # 去除 markdown 格式标记
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"\*([^*]+)\*", r"\1", cleaned)
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    if len(cleaned) > max_len:
        cleaned = cleaned[: max_len - 1] + "…"
    return cleaned


def list_children(parent_node_token, space_id):
    """列出某节点下的所有子节点（分页）。"""
    children = []
    page_token = ""
    while True:
        params = {
            "space_id": space_id,
            "parent_node_token": parent_node_token,
            "page_size": 50,
        }
        if page_token:
            params["page_token"] = page_token

        result = run_lark(
            [
                "wiki",
                "nodes",
                "list",
                "--as",
                "user",
                "--params",
                json.dumps(params),
            ]
        )
        if not result or not (result.get("ok") or result.get("code") == 0):
            break

        data = result.get("data", {})
        items = data.get("items", [])
        children.extend(items)

        if not data.get("has_more"):
            break
        page_token = data.get("page_token", "")
        if not page_token:
            break

    return children


def build_index():
    """从飞书拉取所有节点，构建索引字典。"""
    # 1. 确定 space_id 和 root 节点
    existing = load_index() or load_legacy_state()

    space_id = None
    root_node_token = None
    root_obj_token = None

    if existing:
        space_id = existing.get("space_id")
        root_node_token = existing.get("root", {}).get("node_token") or existing.get(
            "root_node"
        )
        root_obj_token = existing.get("root", {}).get("obj_token") or existing.get(
            "root_obj_token"
        )

    # 首次运行 bootstrap：通过 wiki spaces list 自动发现 "AI Wiki" 空间
    if not space_id or not root_node_token:
        print("未找到现有索引，尝试自动发现 AI Wiki 知识空间...")
        discovered = _auto_discover_wiki_space()
        if discovered:
            space_id = discovered["space_id"]
            root_node_token = discovered["root_node_token"]
            root_obj_token = discovered.get("root_obj_token")
            print(f"✓ 发现 AI Wiki 空间: {space_id}")
        else:
            print("✗ 无法自动发现 AI Wiki 知识空间。")
            print("  请手动创建 .feishu-index.json，或让 A 通过 Claude 初始化。")
            sys.exit(1)

    print(f"知识空间: {space_id}")
    print(f"根节点: {root_node_token}")

    # 2. 查询 root 节点信息（确认 obj_token）
    if not root_obj_token:
        node = fetch_node_info(root_node_token)
        if node:
            root_obj_token = node.get("obj_token")

    index = {
        "last_refreshed": datetime.now().astimezone().isoformat(timespec="seconds"),
        "space_id": space_id,
        "root": {
            "node_token": root_node_token,
            "obj_token": root_obj_token,
            "title": "AI Wiki",
            "url": f"https://www.feishu.cn/wiki/{root_node_token}",
        },
        "categories": {},
        "pages": {},
    }

    # 3. 列出根下的所有子节点（索引 + 4 个分类）
    print("\n扫描根节点...")
    top_children = list_children(root_node_token, space_id)
    log(f"  找到 {len(top_children)} 个顶层节点")

    category_nodes = {}
    for child in top_children:
        title = child.get("title", "")
        node_token = child.get("node_token", "")
        obj_token = child.get("obj_token", "")
        obj_type = child.get("obj_type", "")
        updated = child.get("obj_edit_time", "")

        if title in CATEGORIES:
            # 这是一个分类节点
            index["categories"][title] = {
                "node_token": node_token,
                "obj_token": obj_token,
            }
            category_nodes[title] = node_token
            log(f"  分类: {title}")
        elif obj_type == "docx" and title:
            # 顶层文档页面（如"索引"）
            index["pages"][title] = {
                "category": None,
                "parent_token": root_node_token,
                "node_token": node_token,
                "obj_token": obj_token,
                "url": f"https://www.feishu.cn/wiki/{node_token}",
                "updated": updated,
            }
            log(f"  顶层页面: {title}")

    # 4. 遍历每个分类，收集子页面
    print("\n扫描分类子页面...")
    for category, node_token in category_nodes.items():
        children = list_children(node_token, space_id)
        log(f"  {category}: {len(children)} 个页面")

        for child in children:
            title = child.get("title", "")
            if not title:
                continue
            index["pages"][title] = {
                "category": category,
                "parent_token": node_token,
                "node_token": child.get("node_token", ""),
                "obj_token": child.get("obj_token", ""),
                "url": f"https://www.feishu.cn/wiki/{child.get('node_token', '')}",
                "updated": child.get("obj_edit_time", ""),
            }

    # 5. 合并保留由 feishu_wiki.py 维护的字段：
    #      - attribution: created_by / created_at / updated_by
    #      - summary: 页面未变化时复用
    #    这些字段飞书本身不存，所以 refresh 必须从旧索引里继承，不覆盖。
    existing_index = load_index()
    cached = {}
    if existing_index:
        for title, info in existing_index.get("pages", {}).items():
            cached[title] = info

    PRESERVE_FIELDS = ("created_by", "created_at", "updated_by")
    for title, page_info in index["pages"].items():
        old = cached.get(title, {})
        for field in PRESERVE_FIELDS:
            if field in old:
                page_info[field] = old[field]
        # 若页面未变化，顺带复用 summary
        if old.get("summary") and old.get("updated") == page_info.get("updated"):
            page_info["summary"] = old["summary"]

    # 6. 为未命中缓存的页面拉取正文、提取摘要
    print(f"\n提取摘要...")
    skip_summaries = "--no-summary" in sys.argv
    fetched = 0
    reused = 0
    for title, page_info in index["pages"].items():
        if page_info.get("summary"):
            reused += 1
            log(f"  ✓ 复用: {title}")
            continue
        if skip_summaries:
            continue

        obj_token = page_info.get("obj_token")
        if not obj_token:
            continue
        log(f"  → 拉取: {title}")
        md = fetch_doc_markdown(obj_token)
        summary = extract_summary(md) if md else ""
        page_info["summary"] = summary
        fetched += 1

    if not skip_summaries:
        print(f"  拉取 {fetched} 个新/变化页面，复用 {reused} 个缓存")

    return index


def save_index(index):
    INDEX_FILE.write_text(
        json.dumps(index, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def print_summary(index):
    print("\n═══ 索引摘要 ═══")
    print(f"  刷新时间: {index['last_refreshed']}")
    print(f"  知识空间: {index['space_id']}")
    print(f"  分类数:   {len(index['categories'])}")
    print(f"  页面总数: {len(index['pages'])}")

    # 按分类统计
    by_cat = {}
    for title, info in index["pages"].items():
        cat = info.get("category") or "（顶层）"
        by_cat.setdefault(cat, []).append(title)

    print("\n  分类分布:")
    for cat in ["（顶层）"] + CATEGORIES:
        if cat in by_cat:
            print(f"    {cat}: {len(by_cat[cat])}")


def main():
    print("═══ 刷新飞书索引 ═══\n")
    index = build_index()
    save_index(index)
    print_summary(index)
    print(f"\n✓ 索引已保存到 {INDEX_FILE}")


if __name__ == "__main__":
    main()
