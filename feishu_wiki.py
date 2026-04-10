"""
飞书维基辅助库 —— AI Agent 在"飞书为主 + 本地缓存"架构下操作维基的唯一接口。

架构模型：checkout → local edit → checkin
  - 启动时：_build_cache() 并发拉取全量页面 + 日志到 .cache/
  - 读：全部走 .cache/（零飞书 API，毫秒级）
  - 写：create 立即调飞书（要 obj_token）；update / append_log 只改本地缓存 + 标 dirty
  - 同步：atexit 自动调 sync()，先用 obj_edit_time 做乐观并发检测，再批量上传
  - 冲突：如果飞书端 obj_edit_time 变了（用户手动编辑），报错不覆盖，人工处理

核心契约：
  1. 用户只跟 Agent 对话，不直接编辑飞书 UI（违反会触发冲突保护）
  2. 读操作零延迟（从本地缓存）
  3. 写操作延迟批量（session 结束时一次性 sync）
  4. attribution 写在每个页面顶部的 callout 里
  5. 详细变更历史在 日志 docx 里（每条 `· by 刘宸希`）

典型用法：
    import feishu_wiki as fw
    page = fw.find("智能体上下文与记忆管理")
    content = fw.fetch(page)
    fw.update(page, "追加的段落", mode="append")
    # Python 进程退出时自动 sync

    # 或显式：
    fw.sync()
"""

import atexit
import json
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Optional

# === 常量 ===

CACHE_DIR = Path(".cache")
INDEX_FILE = CACHE_DIR / "index.json"
STATE_FILE = CACHE_DIR / "state.json"
LOG_FILE = CACHE_DIR / "日志.md"
DOCS_DIR = CACHE_DIR / "docs"

# 顶层容器节点（持有其他节点）
TOP_CONTAINERS = ["来源", "主题", "实体", "综合", "原始资料"]
# 原始资料下的子容器
RAW_SUBS = ["论文", "文章", "书籍", "wiki"]
# 特殊 docx（不是 container，有独立处理逻辑 —— 只有日志因为是日志目的地）
SPECIAL_DOCS = ["日志"]

ALL_CATEGORIES = TOP_CONTAINERS + [f"原始资料/{s}" for s in RAW_SUBS]

# 并发度（飞书 API 有频控，4 以内稳妥）
MAX_WORKERS = 4

# === 会话级状态 ===

_CACHE_READY = False
_CURRENT_USER: Optional[dict] = None
_SYNC_LOCK = threading.Lock()
_ATEXIT_REGISTERED = False


# === 底层：lark-cli 调用 ===


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


# === 用户身份 ===


def _current_user() -> dict:
    """获取当前 lark-cli 认证用户 {name, open_id}。模块级缓存。"""
    global _CURRENT_USER
    if _CURRENT_USER is not None:
        return _CURRENT_USER

    try:
        result = subprocess.run(
            ["lark-cli", "auth", "status"],
            capture_output=True, text=True, check=False,
        )
        data = json.loads(result.stdout)
        _CURRENT_USER = {
            "name": data.get("userName") or "unknown",
            "open_id": data.get("userOpenId") or "",
        }
    except Exception:
        _CURRENT_USER = {"name": "unknown", "open_id": ""}

    return _CURRENT_USER


def current_user() -> dict:
    """返回当前用户 {name, open_id}。"""
    return _current_user()


# === 文件名 / 路径工具 ===


def _safe_filename(title: str) -> str:
    """把页面标题转成安全的文件名（保留中文）。"""
    return re.sub(r'[\\/:*?"<>|]', "_", title).strip()


def _doc_cache_path(title: str) -> Path:
    return DOCS_DIR / f"{_safe_filename(title)}.md"


# === 飞书发现 / 遍历 ===


def _auto_discover_space_and_root() -> Optional[dict]:
    """首次初始化时自动发现 AI Wiki 知识空间和根节点。"""
    r = _run_lark(
        ["wiki", "spaces", "list", "--as", "user",
         "--params", json.dumps({"page_size": 50})]
    )
    if not _is_success(r):
        return None
    spaces = r.get("data", {}).get("items", [])
    target = None
    for s in spaces:
        name = s.get("name", "")
        if "AI Wiki" in name or "AI 维基" in name or "AI维基" in name:
            target = s
            break
    if not target and len(spaces) == 1:
        target = spaces[0]
    if not target:
        return None

    space_id = target.get("space_id")
    r = _run_lark(
        ["wiki", "nodes", "list", "--as", "user",
         "--params", json.dumps({"space_id": space_id, "page_size": 50})]
    )
    if not _is_success(r):
        return None
    roots = r.get("data", {}).get("items", [])
    for n in roots:
        if n.get("title", "") in ("AI Wiki", "AI 维基", "AI维基") and n.get("obj_type") == "docx":
            return {
                "space_id": space_id,
                "root_node_token": n.get("node_token"),
                "root_obj_token": n.get("obj_token"),
            }
    # fallback: 第一个 docx
    for n in roots:
        if n.get("obj_type") == "docx":
            return {
                "space_id": space_id,
                "root_node_token": n.get("node_token"),
                "root_obj_token": n.get("obj_token"),
            }
    return None


def _list_children(node_token: str, space_id: str) -> list:
    """列出某节点的直接子节点（自动分页）。"""
    children = []
    page_token = ""
    while True:
        params = {"parent_node_token": node_token, "space_id": space_id, "page_size": 50}
        if page_token:
            params["page_token"] = page_token
        r = _run_lark(
            ["wiki", "nodes", "list", "--as", "user", "--params", json.dumps(params)]
        )
        if not _is_success(r):
            break
        data = r.get("data", {})
        children.extend(data.get("items", []))
        if not data.get("has_more"):
            break
        page_token = data.get("page_token", "")
        if not page_token:
            break
    return children


def _fetch_doc_markdown(obj_token: str, retries: int = 3) -> str:
    """拉取文档正文（Lark-flavored Markdown）。带限流重试。"""
    import time
    for attempt in range(retries):
        try:
            r = _run_lark(
                ["docs", "+fetch", "--as", "user", "--doc", obj_token], check=True
            )
            if _is_success(r):
                return r.get("data", {}).get("markdown", "")
            return ""
        except RuntimeError as e:
            msg = str(e)
            if "frequency limit" in msg or "rate" in msg.lower():
                if attempt < retries - 1:
                    time.sleep(1.5 * (attempt + 1))
                    continue
            raise
    return ""


# === 缓存构建 ===


def _build_cache() -> None:
    """并发拉取全量飞书数据到 .cache/。"""
    print("[fw] 构建本地缓存...", file=sys.stderr, flush=True)

    # 1. 加载旧 index（如存在）用于 bootstrap root
    existing = {}
    if INDEX_FILE.exists():
        try:
            existing = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
        except Exception:
            existing = {}

    space_id = existing.get("space_id")
    root = existing.get("root") or {}
    root_node_token = root.get("node_token")
    root_obj_token = root.get("obj_token")

    if not space_id or not root_node_token:
        # 从 .feishu-config.json 读 bootstrap 配置（git 追踪的一次性配置）
        config = Path(".feishu-config.json")
        if config.exists():
            try:
                cfg = json.loads(config.read_text(encoding="utf-8"))
                space_id = cfg.get("space_id")
                root_node_token = cfg.get("root_node_token")
                root_obj_token = cfg.get("root_obj_token")
            except Exception:
                pass

    if not space_id or not root_node_token:
        discovered = _auto_discover_space_and_root()
        if not discovered:
            raise RuntimeError(
                "无法发现 AI Wiki 知识空间。请创建 .feishu-config.json 手动指定 space_id 和 root_node_token"
            )
        space_id = discovered["space_id"]
        root_node_token = discovered["root_node_token"]
        root_obj_token = discovered.get("root_obj_token")

    # 2. 扫描根节点下的顶层子节点
    top_children = _list_children(root_node_token, space_id)

    containers = {}  # category path → {node_token, obj_token, parent, obj_edit_time}
    pages = {}       # title → {...}
    special_docs = {}  # 日志 / 索引 → {...}

    # 3. 处理顶层子节点
    for child in top_children:
        title = child.get("title", "")
        node_token = child.get("node_token", "")
        obj_token = child.get("obj_token", "")
        obj_type = child.get("obj_type", "")
        edit_time = child.get("obj_edit_time", "")

        if title in TOP_CONTAINERS:
            containers[title] = {
                "node_token": node_token,
                "obj_token": obj_token,
                "parent": None,
                "obj_edit_time": edit_time,
            }
        elif title in SPECIAL_DOCS:
            special_docs[title] = {
                "node_token": node_token,
                "obj_token": obj_token,
                "url": f"https://www.feishu.cn/wiki/{node_token}",
                "obj_edit_time": edit_time,
            }
        elif obj_type == "docx" and title:
            # 其他顶层 docx 作为无分类页面
            pages[title] = {
                "category": None,
                "parent_token": root_node_token,
                "node_token": node_token,
                "obj_token": obj_token,
                "url": f"https://www.feishu.cn/wiki/{node_token}",
                "obj_edit_time": edit_time,
            }

    # 4. 扫描每个容器的直接子节点
    container_tasks = [(name, info["node_token"]) for name, info in containers.items()]

    def _scan_container(args):
        name, node_token = args
        return name, _list_children(node_token, space_id)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        for name, children in ex.map(_scan_container, container_tasks):
            for child in children:
                title = child.get("title", "")
                if not title:
                    continue
                node_token = child.get("node_token", "")
                obj_token = child.get("obj_token", "")
                edit_time = child.get("obj_edit_time", "")

                # 原始资料下是子容器，再向下一层
                if name == "原始资料" and title in RAW_SUBS:
                    path = f"原始资料/{title}"
                    containers[path] = {
                        "node_token": node_token,
                        "obj_token": obj_token,
                        "parent": "原始资料",
                        "obj_edit_time": edit_time,
                    }
                    continue

                pages[title] = {
                    "category": name,
                    "parent_token": containers[name]["node_token"],
                    "node_token": node_token,
                    "obj_token": obj_token,
                    "url": f"https://www.feishu.cn/wiki/{node_token}",
                    "obj_edit_time": edit_time,
                }

    # 5. 扫描原始资料子容器的页面
    raw_sub_tasks = [
        (path, info["node_token"])
        for path, info in containers.items()
        if info.get("parent") == "原始资料"
    ]
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        for name, children in ex.map(_scan_container, raw_sub_tasks):
            for child in children:
                title = child.get("title", "")
                if not title:
                    continue
                pages[title] = {
                    "category": name,  # e.g. "原始资料/论文"
                    "parent_token": containers[name]["node_token"],
                    "node_token": child.get("node_token", ""),
                    "obj_token": child.get("obj_token", ""),
                    "url": f"https://www.feishu.cn/wiki/{child.get('node_token', '')}",
                    "obj_edit_time": child.get("obj_edit_time", ""),
                }

    # 6. 并发拉取所有页面正文
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    def _fetch_and_save(args):
        title, obj_token = args
        md = _fetch_doc_markdown(obj_token)
        _doc_cache_path(title).write_text(md, encoding="utf-8")
        return title

    fetch_tasks = [(t, p["obj_token"]) for t, p in pages.items() if p.get("obj_token")]
    fetched = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = [ex.submit(_fetch_and_save, task) for task in fetch_tasks]
        for fut in as_completed(futures):
            fut.result()
            fetched += 1

    # 7. 拉取 日志 docx
    if "日志" in special_docs:
        md = _fetch_doc_markdown(special_docs["日志"]["obj_token"])
        LOG_FILE.write_text(md, encoding="utf-8")

    # 8. 写 index
    index = {
        "built_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "space_id": space_id,
        "root": {
            "node_token": root_node_token,
            "obj_token": root_obj_token,
        },
        "containers": containers,
        "pages": pages,
        "special_docs": special_docs,
    }
    INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 9. 初始化 state
    state = {
        "started_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "dirty_pages": [],
        "dirty_log": False,
        "last_sync_at": None,
    }
    STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(
        f"[fw] 缓存就绪：{len(pages)} 个页面，{len(containers)} 个容器",
        file=sys.stderr, flush=True,
    )


def _ensure_cache() -> None:
    """确保缓存可用。如果不存在则构建。幂等。"""
    global _CACHE_READY, _ATEXIT_REGISTERED
    if _CACHE_READY:
        return

    if not INDEX_FILE.exists() or not STATE_FILE.exists():
        _build_cache()
    else:
        # 已有缓存，但要确保 DOCS_DIR 存在
        DOCS_DIR.mkdir(parents=True, exist_ok=True)

    _CACHE_READY = True

    if not _ATEXIT_REGISTERED:
        atexit.register(_atexit_sync)
        _ATEXIT_REGISTERED = True


def _atexit_sync():
    """Python 进程退出时自动 sync。"""
    try:
        state = _load_state()
        if state.get("dirty_pages") or state.get("dirty_log"):
            print("[fw] atexit: 自动同步未提交变更...", file=sys.stderr, flush=True)
            sync()
    except Exception as e:
        print(f"[fw] atexit sync 失败: {e}", file=sys.stderr, flush=True)


# === 状态管理 ===


def _load_index() -> dict:
    return json.loads(INDEX_FILE.read_text(encoding="utf-8"))


def _save_index(index: dict) -> None:
    INDEX_FILE.write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _load_state() -> dict:
    if not STATE_FILE.exists():
        return {"dirty_pages": [], "dirty_log": False}
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def _save_state(state: dict) -> None:
    STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _mark_dirty_page(title: str) -> None:
    state = _load_state()
    if title not in state.get("dirty_pages", []):
        state.setdefault("dirty_pages", []).append(title)
    _save_state(state)


def _mark_dirty_log() -> None:
    state = _load_state()
    state["dirty_log"] = True
    _save_state(state)


# === 查找 / 读取 ===


def find(query: str, category: Optional[str] = None) -> Optional[dict]:
    """按标题查找页面。精确匹配优先，回退到包含匹配。"""
    _ensure_cache()
    index = _load_index()
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
    _ensure_cache()
    index = _load_index()
    result = []
    for title, info in index.get("pages", {}).items():
        if category is None or info.get("category") == category:
            result.append({"title": title, **info})
    return result


def exists(title: str) -> bool:
    return find(title) is not None


def fetch(page_or_title) -> str:
    """从本地缓存读取页面正文。零 API 调用。"""
    _ensure_cache()
    if isinstance(page_or_title, dict):
        title = page_or_title.get("title", "")
    else:
        title = page_or_title

    path = _doc_cache_path(title)
    if not path.exists():
        # 缓存缺失，回退到 API
        page = find(title)
        if not page:
            raise ValueError(f"找不到页面: {title}")
        md = _fetch_doc_markdown(page["obj_token"])
        path.write_text(md, encoding="utf-8")
        return md
    return path.read_text(encoding="utf-8")


# === attribution callout ===


_CALLOUT_RE = re.compile(
    r'<callout emoji="(?:👤|member|user)"[^>]*>.*?</callout>',
    re.DOTALL,
)


def _make_attribution_callout(created_by: dict, updated_by: dict, created_at: str, updated_at: str) -> str:
    """生成 attribution callout 块。"""
    cn = created_by.get("name", "unknown")
    un = updated_by.get("name", "unknown")
    cd = (created_at or "")[:10]
    ud = (updated_at or "")[:10]
    return (
        f'<callout emoji="👤" background-color="light-gray-background">\n'
        f'**创建**：{cn}（{cd}） · **最后更新**：{un}（{ud}）\n'
        f'</callout>'
    )


def _extract_attribution(content: str) -> Optional[dict]:
    """从内容中提取已有的 attribution callout 信息（用于保留 created_by）。"""
    m = re.search(
        r'<callout emoji="👤"[^>]*>(.*?)</callout>',
        content, re.DOTALL,
    )
    if not m:
        return None
    body = m.group(1)
    cm = re.search(r'\*\*创建\*\*：([^（]+)（([^）]*)）', body)
    um = re.search(r'\*\*最后更新\*\*：([^（]+)（([^）]*)）', body)
    return {
        "created_name": cm.group(1).strip() if cm else None,
        "created_date": cm.group(2).strip() if cm else None,
        "updated_name": um.group(1).strip() if um else None,
        "updated_date": um.group(2).strip() if um else None,
    }


def _upsert_attribution(content: str, is_create: bool) -> str:
    """把 attribution callout 插入或更新到 content 顶部。"""
    user = _current_user()
    today = datetime.now().strftime("%Y-%m-%d")

    existing = _extract_attribution(content)
    if existing and existing.get("created_name"):
        # 保留旧的 created 信息
        created = {"name": existing["created_name"]}
        created_at = existing.get("created_date", today)
    else:
        created = user
        created_at = today

    updated = user
    updated_at = today

    new_callout = _make_attribution_callout(
        created, updated, created_at, updated_at
    )

    if existing:
        # 替换现有 callout
        return re.sub(
            r'<callout emoji="👤"[^>]*>.*?</callout>',
            new_callout, content, count=1, flags=re.DOTALL,
        )
    else:
        # 插入到顶部（如果有其他 callout，插到它们之后）
        # 找到第一个非 callout 的内容位置
        other_callouts = re.match(
            r'((?:<callout[^>]*>.*?</callout>\s*)*)',
            content, re.DOTALL,
        )
        if other_callouts and other_callouts.group(1):
            prefix = other_callouts.group(1)
            rest = content[len(prefix):]
            return prefix + new_callout + "\n\n" + rest
        return new_callout + "\n\n" + content


# === 创建 / 更新 ===


def create(category: str, title: str, content: str) -> dict:
    """
    在指定分类下创建新页面。立即调飞书（需要拿 obj_token），同时写本地缓存。

    category: "来源" / "主题" / "实体" / "综合" / "原始资料/论文" 等
    """
    _ensure_cache()

    if category not in ALL_CATEGORIES and category != "原始资料":
        raise ValueError(f"无效分类: {category}，可选: {ALL_CATEGORIES}")

    if exists(title):
        raise ValueError(f"页面已存在: {title}（请用 update）")

    index = _load_index()
    container = index["containers"].get(category)
    if not container:
        raise ValueError(f"找不到分类容器: {category}")
    parent_token = container["node_token"]

    # 插入 attribution callout
    content = _upsert_attribution(content, is_create=True)

    r = _run_lark(
        ["docs", "+create", "--as", "user",
         "--wiki-node", parent_token,
         "--title", title,
         "--markdown", content],
        check=True,
    )
    if not _is_success(r):
        raise RuntimeError(f"create 失败: {r}")

    data = r.get("data", {})
    doc_id = data.get("doc_id")
    doc_url = data.get("doc_url", "")
    node_token = doc_url.split("/")[-1] if "/wiki/" in doc_url else ""

    # 本地缓存
    _doc_cache_path(title).write_text(content, encoding="utf-8")

    new_page = {
        "category": category,
        "parent_token": parent_token,
        "node_token": node_token,
        "obj_token": doc_id,
        "url": doc_url,
        "obj_edit_time": "",  # 刚创建，下次 sync 前会更新
    }
    index.setdefault("pages", {})[title] = new_page
    _save_index(index)

    append_log(f"创建 | {title}", details=f"分类：{category}")

    return {"title": title, **new_page}


def update(
    page_or_title,
    content: str,
    mode: str = "append",
) -> None:
    """
    更新页面。只改本地缓存 + 标 dirty。atexit 或显式 sync 时才上传。

    mode: append（推荐）/ overwrite
    """
    _ensure_cache()

    if isinstance(page_or_title, dict):
        title = page_or_title.get("title", "")
    else:
        title = page_or_title

    if not find(title):
        raise ValueError(f"找不到页面: {title}")

    path = _doc_cache_path(title)
    if not path.exists():
        # 冷加载
        fetch(title)

    current = path.read_text(encoding="utf-8")

    if mode == "append":
        new_content = current.rstrip() + "\n\n" + content
    elif mode == "overwrite":
        new_content = content
    else:
        raise ValueError(f"不支持的 mode: {mode}（只支持 append / overwrite）")

    # 更新 attribution
    new_content = _upsert_attribution(new_content, is_create=False)

    path.write_text(new_content, encoding="utf-8")
    _mark_dirty_page(title)
    append_log(f"更新 | {title}", details=f"mode={mode}")


# === 日志（本地缓存 → sync 时上传到飞书 日志 docx）===


def append_log(summary: str, details: Optional[str] = None) -> None:
    """追加一条日志。只改本地缓存，sync 时上传。"""
    _ensure_cache()
    today = datetime.now().strftime("%Y-%m-%d")
    user = _current_user()
    by_line = f" · by {user['name']}" if user.get("name") else ""
    entry = f"\n## [{today}] {summary}{by_line}\n"
    if details:
        entry += f"{details}\n"

    if LOG_FILE.exists():
        existing = LOG_FILE.read_text(encoding="utf-8")
        LOG_FILE.write_text(existing + entry, encoding="utf-8")
    else:
        LOG_FILE.write_text(f"# 日志\n{entry}", encoding="utf-8")

    _mark_dirty_log()


# === 同步（checkin）===


def _refetch_edit_times(obj_tokens: list) -> dict:
    """重新拉取指定页面的 obj_edit_time，用于冲突检测。串行避免 atexit 问题。"""
    result = {}
    index = _load_index()
    space_id = index["space_id"]

    target_set = set(obj_tokens)

    # 扫所有容器的直接子
    for name, info in index["containers"].items():
        for child in _list_children(info["node_token"], space_id):
            ot = child.get("obj_token", "")
            if ot in target_set:
                result[ot] = child.get("obj_edit_time", "")
        if len(result) >= len(target_set):
            return result

    # 特殊 docs（日志）在根节点下
    need_root_scan = any(
        index.get("special_docs", {}).get(name, {}).get("obj_token", "") in target_set
        for name in SPECIAL_DOCS
    )
    if need_root_scan:
        for c in _list_children(index["root"]["node_token"], space_id):
            ot = c.get("obj_token", "")
            if ot in target_set:
                result[ot] = c.get("obj_edit_time", "")

    return result


def sync() -> dict:
    """
    同步本地 dirty 变更到飞书。
    返回 {uploaded: N, conflicts: [title1, ...]}.
    """
    with _SYNC_LOCK:
        state = _load_state()
        dirty_pages = state.get("dirty_pages", [])
        dirty_log = state.get("dirty_log", False)

        if not dirty_pages and not dirty_log:
            return {"uploaded": 0, "conflicts": []}

        index = _load_index()
        pages = index.get("pages", {})

        # 1. 收集要检查的 obj_token
        check_tokens = []
        for title in dirty_pages:
            p = pages.get(title)
            if p and p.get("obj_token"):
                check_tokens.append(p["obj_token"])
        if dirty_log and "日志" in index.get("special_docs", {}):
            check_tokens.append(index["special_docs"]["日志"]["obj_token"])

        # 2. 冲突检测：重新拉取 obj_edit_time
        print(f"[fw] 冲突检测：{len(check_tokens)} 个页面", file=sys.stderr, flush=True)
        current_times = _refetch_edit_times(check_tokens)

        conflicts = []
        for title in dirty_pages:
            p = pages.get(title)
            if not p:
                continue
            cached_time = p.get("obj_edit_time", "")
            current_time = current_times.get(p["obj_token"], "")
            if cached_time and current_time and cached_time != current_time:
                conflicts.append(title)

        if dirty_log and "日志" in index.get("special_docs", {}):
            log_info = index["special_docs"]["日志"]
            cached = log_info.get("obj_edit_time", "")
            current = current_times.get(log_info["obj_token"], "")
            if cached and current and cached != current:
                conflicts.append("日志")

        if conflicts:
            raise RuntimeError(
                f"冲突：以下页面在飞书被其他人修改过，拒绝覆盖：{conflicts}。"
                f"请检查后手动处理（可能需要 fw.refresh() 重建缓存，再重新应用改动）"
            )

        # 3. 无冲突，批量上传
        uploaded = 0
        for title in list(dirty_pages):
            p = pages.get(title)
            if not p:
                continue
            path = _doc_cache_path(title)
            if not path.exists():
                continue
            content = path.read_text(encoding="utf-8")
            r = _run_lark(
                ["docs", "+update", "--as", "user",
                 "--doc", p["obj_token"],
                 "--mode", "overwrite",
                 "--markdown", content],
                check=True,
            )
            if not _is_success(r):
                raise RuntimeError(f"上传失败 {title}: {r}")
            uploaded += 1

        # 4. 上传日志
        if dirty_log and "日志" in index.get("special_docs", {}):
            log_info = index["special_docs"]["日志"]
            content = LOG_FILE.read_text(encoding="utf-8") if LOG_FILE.exists() else "# 日志\n"
            r = _run_lark(
                ["docs", "+update", "--as", "user",
                 "--doc", log_info["obj_token"],
                 "--mode", "overwrite",
                 "--markdown", content],
                check=True,
            )
            if not _is_success(r):
                raise RuntimeError(f"日志上传失败: {r}")
            uploaded += 1

        # 5. 更新本地 obj_edit_time 为最新
        new_times = _refetch_edit_times(check_tokens)
        for title in dirty_pages:
            p = pages.get(title)
            if p and p["obj_token"] in new_times:
                p["obj_edit_time"] = new_times[p["obj_token"]]
        if dirty_log and "日志" in index.get("special_docs", {}):
            log_info = index["special_docs"]["日志"]
            if log_info["obj_token"] in new_times:
                log_info["obj_edit_time"] = new_times[log_info["obj_token"]]
        _save_index(index)

        # 6. 清 dirty
        state["dirty_pages"] = []
        state["dirty_log"] = False
        state["last_sync_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        _save_state(state)

        print(f"[fw] ✓ 已同步 {uploaded} 项", file=sys.stderr, flush=True)
        return {"uploaded": uploaded, "conflicts": []}


def refresh() -> None:
    """强制重建缓存。先 sync 未提交变更，再重新拉取。"""
    state = _load_state()
    if state.get("dirty_pages") or state.get("dirty_log"):
        sync()
    global _CACHE_READY
    _CACHE_READY = False
    _build_cache()
    _CACHE_READY = True


def status() -> dict:
    """查看当前缓存状态和未同步变更。"""
    if not INDEX_FILE.exists():
        return {"cache": "missing"}
    index = _load_index()
    state = _load_state()
    return {
        "cache": "ready",
        "built_at": index.get("built_at"),
        "pages": len(index.get("pages", {})),
        "dirty_pages": state.get("dirty_pages", []),
        "dirty_log": state.get("dirty_log", False),
        "last_sync_at": state.get("last_sync_at"),
    }


# === 维基链接解析 ===


def resolve_wikilinks(content: str) -> str:
    """把 [[页面名]] 或 [[页面名|显示]] 转成 <mention-doc> 标签。"""
    _ensure_cache()

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


# === 便捷搜索 ===


def search_feishu(keyword: str, limit: int = 10) -> list:
    """通过飞书搜索 API 按关键词查找文档。"""
    _ensure_cache()
    r = _run_lark(
        ["docs", "+search", "--as", "user", "--query", keyword, "--limit", str(limit)]
    )
    if not _is_success(r):
        return []
    return r.get("data", {}).get("items", [])
