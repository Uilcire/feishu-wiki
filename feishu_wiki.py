"""
飞书维基辅助库 —— AI Agent 在"飞书为主"架构下操作维基的唯一接口。

适配：Claude Code、Codex、以及任何能运行 Python 的 AI Agent。

核心契约（CLAUDE.md 的"黑盒模型"）：
  1. 用户只跟 Agent 对话，所有飞书 + git 操作由 Agent 代劳
  2. 所有读前：自动 git pull + refresh（_ensure_ready）
  3. 所有写后：自动追加日志、更新本地索引
  4. 每批操作结束时：fw.commit("消息") 统一提交 git 并 push
  5. 用户不直接动飞书 UI 的编辑，不跑 git 命令

典型用法：

    import feishu_wiki as fw

    # 读（自动 pull + refresh）
    page = fw.find("智能体上下文与记忆管理")
    print(page["summary"])
    content = fw.fetch(page)

    # 写（自动记日志）
    fw.create("主题", "新主题", "## 概述\\n\\n...")
    fw.update("智能体上下文与记忆管理", "追加内容", mode="append")

    # 源文件（通过 Agent 的 WebFetch 拿到文本后保存）
    fw.save_source_from_text(
        text="...",
        category="文章",
        title="某文章标题",
        metadata={"url": "https://...", "author": "...", "date": "..."}
    )

    # 批次结束，原子提交
    fw.commit("收录：某文章标题")
"""

import json
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional

INDEX_FILE = Path(".feishu-index.json")
LOG_FILE = Path("日志.md")
QUEUE_FILE = Path("阅读队列.md")
SOURCE_DIR = Path("原始资料")
CATEGORIES = ["来源", "主题", "实体", "综合"]

# 会话级状态
_READY = False
_PENDING_FILES: set = set()  # 待提交的文件路径
_PENDING_SUMMARY: list = []  # 本次会话的变更概要（用于 commit message 参考）


# === 底层：lark-cli 和 git ===


def _run_lark(args: list, check: bool = False) -> Optional[dict]:
    """执行 lark-cli 命令，返回解析后的 JSON。"""
    result = subprocess.run(["lark-cli"] + args, capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        if check:
            stderr_msg = result.stderr[:500] if result.stderr else result.stdout[:500]
            raise RuntimeError(f"lark-cli 失败: {stderr_msg}")
        return None


def _is_success(result: Optional[dict]) -> bool:
    return bool(result) and (result.get("ok") or result.get("code") == 0)


def _run_git(args: list, check: bool = True) -> subprocess.CompletedProcess:
    """执行 git 命令。"""
    return subprocess.run(
        ["git"] + args,
        capture_output=True,
        text=True,
        check=check,
    )


# === 就绪检查（自动 pull + refresh）===


def _ensure_ready(force: bool = False) -> None:
    """
    确保本地状态是最新的。在每次读写操作前自动调用。

    步骤：
      1. git pull（同步其他 agent 的最新提交）
      2. refresh 索引（同步飞书最新状态）

    force=True 时强制重跑即使已初始化。
    """
    global _READY
    if _READY and not force:
        return

    # 1. git pull
    try:
        result = _run_git(["pull", "--ff-only"], check=False)
        if result.returncode != 0:
            print(f"[fw] git pull 警告: {result.stderr.strip()}", flush=True)
    except Exception as e:
        print(f"[fw] git pull 失败: {e}", flush=True)

    # 2. refresh 索引
    refresh_result = subprocess.run(
        ["python3", "refresh-index.py"],
        capture_output=True,
        text=True,
    )
    if refresh_result.returncode != 0:
        raise RuntimeError(f"refresh-index 失败: {refresh_result.stderr}")

    _READY = True


def ready() -> None:
    """显式触发就绪检查（通常不需要手动调用，所有读写会自动）。"""
    _ensure_ready(force=True)


# === 索引管理 ===


def refresh() -> dict:
    """从飞书拉取最新元数据，重建本地索引。（显式调用；读写操作会自动触发）"""
    _ensure_ready(force=True)
    return load()


def load() -> dict:
    """读取本地索引文件。"""
    if not INDEX_FILE.exists():
        # 自动触发初始化
        _ensure_ready()
    return json.loads(INDEX_FILE.read_text(encoding="utf-8"))


def _save_index(index: dict) -> None:
    INDEX_FILE.write_text(
        json.dumps(index, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    _PENDING_FILES.add(str(INDEX_FILE))


# === 查找 ===


def find(query: str, category: Optional[str] = None) -> Optional[dict]:
    """按标题查找页面。精确匹配优先，回退到包含匹配。"""
    _ensure_ready()
    index = load()
    pages = index.get("pages", {})

    if query in pages:
        page = pages[query]
        if category is None or page.get("category") == category:
            return {**page, "title": query}

    matches = []
    for title, info in pages.items():
        if category is not None and info.get("category") != category:
            continue
        if query in title or title in query:
            matches.append({**info, "title": title})

    if matches:
        matches.sort(key=lambda x: len(x["title"]))
        return matches[0]

    return None


def list_pages(category: Optional[str] = None) -> list:
    """列出所有页面（可按分类过滤）。"""
    _ensure_ready()
    index = load()
    result = []
    for title, info in index.get("pages", {}).items():
        if category is None or info.get("category") == category:
            result.append({"title": title, **info})
    return result


def exists(title: str) -> bool:
    """检查页面是否存在。"""
    return find(title) is not None


# === 读取内容 ===


def fetch(page_or_title) -> str:
    """获取页面正文（Lark-flavored Markdown）。"""
    _ensure_ready()
    if isinstance(page_or_title, dict):
        doc_id = page_or_title.get("obj_token")
    else:
        page = find(page_or_title)
        if not page:
            raise ValueError(f"找不到页面: {page_or_title}")
        doc_id = page["obj_token"]

    result = _run_lark(
        ["docs", "+fetch", "--as", "user", "--doc", doc_id],
        check=True,
    )
    if not _is_success(result):
        raise RuntimeError(f"fetch 失败: {result}")
    return result.get("data", {}).get("markdown", "")


# === 写入操作（飞书 + 自动记日志 + 标记待提交）===


def create(category: str, title: str, content: str) -> dict:
    """在指定分类下创建新页面。自动追加日志、更新索引、标记 commit 待提交。"""
    _ensure_ready()

    if category not in CATEGORIES:
        raise ValueError(f"无效分类: {category}，必须是 {CATEGORIES}")

    if exists(title):
        raise ValueError(f"页面已存在: {title}（请使用 update）")

    index = load()
    cat_info = index.get("categories", {}).get(category, {})
    parent_token = cat_info.get("node_token")
    if not parent_token:
        raise ValueError(f"找不到分类节点: {category}")

    result = _run_lark(
        [
            "docs",
            "+create",
            "--as",
            "user",
            "--wiki-node",
            parent_token,
            "--title",
            title,
            "--markdown",
            content,
        ],
        check=True,
    )
    if not _is_success(result):
        raise RuntimeError(f"create 失败: {result}")

    data = result.get("data", {})
    doc_id = data.get("doc_id")
    doc_url = data.get("doc_url", "")

    new_page = {
        "category": category,
        "parent_token": parent_token,
        "node_token": doc_url.split("/")[-1] if "/wiki/" in doc_url else "",
        "obj_token": doc_id,
        "url": doc_url,
        "updated": datetime.now().astimezone().isoformat(timespec="seconds"),
        "summary": _extract_summary_fallback(content),
    }

    index.setdefault("pages", {})[title] = new_page
    _save_index(index)

    append_log(f"创建 | {title}", details=f"分类：{category}")
    _PENDING_SUMMARY.append(f"创建 {category}/{title}")

    return {"title": title, **new_page}


def update(
    page_or_title, content: str, mode: str = "append", new_title: Optional[str] = None
) -> None:
    """
    更新页面内容。自动追加日志、更新索引、标记 commit 待提交。

    mode:
      - append（推荐）: 追加到末尾
      - overwrite: 完全覆盖（慎用）
      - replace_range / insert_before / insert_after / delete_range / replace_all: 定位更新
    """
    _ensure_ready()

    if isinstance(page_or_title, dict):
        title = page_or_title.get("title", "")
        doc_id = page_or_title.get("obj_token")
    else:
        title = page_or_title
        page = find(title)
        if not page:
            raise ValueError(f"找不到页面: {title}")
        doc_id = page["obj_token"]

    args = [
        "docs",
        "+update",
        "--as",
        "user",
        "--doc",
        doc_id,
        "--mode",
        mode,
        "--markdown",
        content,
    ]
    if new_title:
        args += ["--new-title", new_title]

    result = _run_lark(args, check=True)
    if not _is_success(result):
        raise RuntimeError(f"update 失败: {result}")

    if title:
        index = load()
        if title in index.get("pages", {}):
            index["pages"][title]["updated"] = (
                datetime.now().astimezone().isoformat(timespec="seconds")
            )
            if new_title and new_title != title:
                index["pages"][new_title] = index["pages"].pop(title)
            _save_index(index)

    log_title = new_title or title
    append_log(f"更新 | {log_title}", details=f"mode={mode}")
    _PENDING_SUMMARY.append(f"更新 {log_title}")


# === 日志（本地，自动标记待提交）===


def append_log(summary: str, details: Optional[str] = None) -> None:
    """追加一条日志到本地 日志.md。自动标记 commit 待提交。"""
    today = datetime.now().strftime("%Y-%m-%d")
    entry = f"\n## [{today}] {summary}\n"
    if details:
        entry += f"{details}\n"

    if LOG_FILE.exists():
        existing = LOG_FILE.read_text(encoding="utf-8")
        LOG_FILE.write_text(existing + entry, encoding="utf-8")
    else:
        LOG_FILE.write_text(f"# 日志\n{entry}", encoding="utf-8")

    _PENDING_FILES.add(str(LOG_FILE))


# === 阅读队列（本地）===


def queue_add(title: str, url: str = "", note: str = "", tags: Optional[list] = None) -> None:
    """追加一条到阅读队列的「待读」分区。"""
    today = datetime.now().strftime("%Y-%m-%d")
    tag_str = ", ".join(tags) if tags else ""
    entry = f"\n- **{title}** | {url} | 添加于 {today} | 标签：{tag_str}\n"
    if note:
        entry += f"  备注：{note}\n"

    if QUEUE_FILE.exists():
        existing = QUEUE_FILE.read_text(encoding="utf-8")
        QUEUE_FILE.write_text(existing + entry, encoding="utf-8")
    else:
        QUEUE_FILE.write_text(f"# 阅读队列\n\n## 待读\n{entry}\n## 已收录\n", encoding="utf-8")

    _PENDING_FILES.add(str(QUEUE_FILE))


# === 源文件管理 ===


def save_source_from_text(
    text: str,
    category: str,
    title: str,
    metadata: Optional[dict] = None,
) -> Path:
    """
    把文本内容保存为源文件（`原始资料/<category>/<slug>.md`）。

    category 是 原始资料/ 下的子目录名（"文章"、"论文"、"书籍"、"wiki" 等）。
    title 用于生成文件名和在文件里做标题。
    metadata 是可选的 dict，会被写成文件开头的元数据块。

    返回：源文件路径。自动标记 commit 待提交。

    典型用法（在 Claude Code / Codex 里）：
      1. Agent 用 WebFetch 拉取 URL 得到文本
      2. 调用 fw.save_source_from_text(text, "文章", "某标题", {"url": ..., "author": ...})
      3. 拿到返回的路径，之后按常规流程收录
    """
    cat_dir = SOURCE_DIR / category
    cat_dir.mkdir(parents=True, exist_ok=True)

    # 生成安全的文件名（保留中文，去掉路径危险字符）
    slug = re.sub(r'[\\/:*?"<>|]', "", title).strip()
    if not slug:
        raise ValueError(f"无效标题: {title}")

    file_path = cat_dir / f"{slug}.md"
    if file_path.exists():
        raise FileExistsError(f"源文件已存在: {file_path}")

    # 构造文件内容：可选的 metadata 块 + 原文
    parts = []
    if metadata:
        parts.append("---")
        for k, v in metadata.items():
            if isinstance(v, list):
                v = ", ".join(str(x) for x in v)
            parts.append(f"{k}: {v}")
        parts.append("---\n")
    parts.append(f"# {title}\n")
    parts.append(text.strip())

    file_path.write_text("\n".join(parts), encoding="utf-8")
    _PENDING_FILES.add(str(file_path))

    append_log(
        f"保存源文件 | {title}",
        details=f"{file_path}",
    )
    _PENDING_SUMMARY.append(f"保存源文件 {category}/{slug}")

    return file_path


# === 引用解析（把 [[维基链接]] 转成 mention-doc）===


def resolve_wikilinks(content: str) -> str:
    """把 [[页面名]] 或 [[页面名|显示]] 转成 <mention-doc> 标签。"""
    _ensure_ready()

    def replacer(match):
        raw = match.group(1)
        if "|" in raw:
            target, display = raw.split("|", 1)
        else:
            target = display = raw
        page = find(target.strip())
        if page and page.get("obj_token"):
            token = page["obj_token"]
            return f'<mention-doc token="{token}" type="docx">{display.strip()}</mention-doc>'
        return f"**{display.strip()}**"

    return re.sub(r"\[\[([^\]]+)\]\]", replacer, content)


# === 批次提交 ===


def commit(message: str, push: bool = True) -> None:
    """
    提交本批次的所有变更到 git（可选 push）。

    会自动 add：
      - 所有 _PENDING_FILES 里的文件（索引、日志、队列、源文件等）
      - 调用者可以通过 extra_files 参数追加额外文件（TODO）

    典型用法：
      收录完成后：fw.commit("收录：某来源标题")
      查询归档后：fw.commit("查询归档：某问题")
      审查修复后：fw.commit("审查：修复交叉引用")
    """
    if not _PENDING_FILES:
        print("[fw] 无待提交的变更，跳过")
        return

    # stage 所有 pending 文件
    files_to_add = sorted(_PENDING_FILES)
    _run_git(["add"] + files_to_add, check=True)

    # 检查是否真的有变化
    status = _run_git(["status", "--porcelain"], check=True)
    if not status.stdout.strip():
        print("[fw] 工作区无实际变化，跳过提交")
        _PENDING_FILES.clear()
        _PENDING_SUMMARY.clear()
        return

    _run_git(["commit", "-m", message], check=True)

    if push:
        _run_git(["push"], check=False)

    print(f"[fw] ✓ 提交完成: {message}")
    if _PENDING_SUMMARY:
        for s in _PENDING_SUMMARY:
            print(f"      - {s}")

    _PENDING_FILES.clear()
    _PENDING_SUMMARY.clear()


def pending() -> dict:
    """查看当前未提交的变更（用于 Agent 决策何时 commit）。"""
    return {
        "files": sorted(_PENDING_FILES),
        "operations": list(_PENDING_SUMMARY),
    }


# === 便捷搜索（飞书原生全文搜索）===


def search_feishu(keyword: str, limit: int = 10) -> list:
    """通过飞书搜索 API 按关键词查找文档（用于索引之外的全文搜索）。"""
    _ensure_ready()
    result = _run_lark(
        [
            "docs",
            "+search",
            "--as",
            "user",
            "--query",
            keyword,
            "--limit",
            str(limit),
        ]
    )
    if not _is_success(result):
        return []
    return result.get("data", {}).get("items", [])


# === 内部工具 ===


def _extract_summary_fallback(content: str, max_len: int = 150) -> str:
    """从新建页面的内容里提取一段简短摘要（fallback，refresh 会再用正式逻辑覆盖）。"""
    # 去掉 HTML 标签
    text = re.sub(r"<[^>]+>", "", content)
    # 取第一段
    for para in text.split("\n\n"):
        para = para.strip()
        if para and not para.startswith("#"):
            # 去掉 markdown 格式
            para = re.sub(r"\*+([^*]+)\*+", r"\1", para)
            para = re.sub(r"\s+", " ", para)
            return para[:max_len] + ("…" if len(para) > max_len else "")
    return ""
