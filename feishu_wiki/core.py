"""
feishu_wiki.core —— 索引、缓存、读写

架构模型：lazy cache + on-demand fetch
  - 启动时：只拉索引（页面列表 + summary + edit_time）和日志
  - 读：先查索引定位，按需拉取单个页面（本地缓存 + TTL）
  - 写：acquire lock → fetch fresh → modify → upload → release lock
  - 索引 TTL = 60s，过期自动刷新
"""

import atexit
import json
import re
import subprocess
import sys
import threading
import time as _time
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

# 默认 AI Wiki 知识空间
DEFAULT_SPACE_ID = "7612481259192781765"

# 顶层容器节点
TOP_CONTAINERS = ["来源", "主题", "实体", "综合", "原始资料"]
RAW_SUBS = ["论文", "文章", "书籍", "wiki"]
SPECIAL_DOCS = ["日志"]
ALL_CATEGORIES = TOP_CONTAINERS + [f"原始资料/{s}" for s in RAW_SUBS]

# 并发度（飞书 API 频控，4 以内稳妥）
MAX_WORKERS = 4

# 索引 TTL（秒）
INDEX_TTL = 60

# === 会话级状态 ===

_CACHE_READY = False
_CURRENT_USER: Optional[dict] = None
_SYNC_LOCK = threading.Lock()
_ATEXIT_REGISTERED = False
_INDEX_LAST_REFRESH: float = 0  # time.time() of last index refresh


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
    return re.sub(r'[\\/:*?"<>|]', "_", title).strip()


def _doc_cache_path(title: str) -> Path:
    return DOCS_DIR / f"{_safe_filename(title)}.md"


# === 飞书发现 / 遍历 ===


def _auto_discover_space_and_root() -> Optional[dict]:
    """自动发现 AI Wiki 知识空间和根节点。"""
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
                    _time.sleep(1.5 * (attempt + 1))
                    continue
            raise
    return ""


# === 索引构建（轻量：只拉页面列表 + metadata，不拉正文）===


def _build_index() -> dict:
    """扫描飞书知识库结构，构建索引（不拉页面正文）。"""
    print("[fw] 构建索引...", file=sys.stderr, flush=True)

    # 1. 确定 space_id 和 root
    space_id = None
    root_node_token = None
    root_obj_token = None

    config = Path(".feishu-config.json")
    if config.exists():
        try:
            cfg = json.loads(config.read_text(encoding="utf-8"))
            space_id = cfg.get("space_id")
            root_node_token = cfg.get("root_node_token")
            root_obj_token = cfg.get("root_obj_token")
        except Exception:
            pass

    if not space_id:
        space_id = DEFAULT_SPACE_ID

    if not root_node_token:
        discovered = _auto_discover_space_and_root()
        if not discovered:
            raise RuntimeError("无法发现 AI Wiki 知识空间。请创建 .feishu-config.json")
        space_id = discovered["space_id"]
        root_node_token = discovered["root_node_token"]
        root_obj_token = discovered.get("root_obj_token")

    # 2. 扫描根节点
    top_children = _list_children(root_node_token, space_id)

    containers = {}
    pages = {}
    special_docs = {}

    for child in top_children:
        title = child.get("title", "")
        node_token = child.get("node_token", "")
        obj_token = child.get("obj_token", "")
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
                "url": f"https://bytedance.larkoffice.com/wiki/{node_token}",
                "obj_edit_time": edit_time,
            }
        elif child.get("obj_type") == "docx" and title:
            pages[title] = {
                "category": None,
                "parent_token": root_node_token,
                "node_token": node_token,
                "obj_token": obj_token,
                "url": f"https://bytedance.larkoffice.com/wiki/{node_token}",
                "obj_edit_time": edit_time,
                "summary": "",
            }

    # 3. 扫描容器（并发）
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

                if name == "原始资料" and title in RAW_SUBS:
                    containers[f"原始资料/{title}"] = {
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
                    "url": f"https://bytedance.larkoffice.com/wiki/{node_token}",
                    "obj_edit_time": edit_time,
                    "summary": "",
                }

    # 4. 扫描原始资料子容器
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
                    "category": name,
                    "parent_token": containers[name]["node_token"],
                    "node_token": child.get("node_token", ""),
                    "obj_token": child.get("obj_token", ""),
                    "url": f"https://bytedance.larkoffice.com/wiki/{child.get('node_token', '')}",
                    "obj_edit_time": child.get("obj_edit_time", ""),
                    "summary": "",
                }

    # 5. 保留旧索引中的 summary
    if INDEX_FILE.exists():
        try:
            old_index = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
            old_pages = old_index.get("pages", {})
            for title, info in pages.items():
                if title in old_pages and old_pages[title].get("summary"):
                    info["summary"] = old_pages[title]["summary"]
        except Exception:
            pass

    # 6. 拉取日志
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    if "日志" in special_docs:
        md = _fetch_doc_markdown(special_docs["日志"]["obj_token"])
        LOG_FILE.write_text(md, encoding="utf-8")

    # 7. 写索引
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

    # 8. 初始化 state（如不存在）
    if not STATE_FILE.exists():
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
        f"[fw] 索引就绪：{len(pages)} 个页面，{len(containers)} 个容器",
        file=sys.stderr, flush=True,
    )
    return index


def _refresh_index_if_stale() -> dict:
    """如果索引 TTL 过期，重新拉取。否则返回本地缓存。"""
    global _INDEX_LAST_REFRESH
    now = _time.time()
    if INDEX_FILE.exists() and (now - _INDEX_LAST_REFRESH) < INDEX_TTL:
        return _load_index()
    index = _build_index()
    _INDEX_LAST_REFRESH = now
    return index


def init(space_id: Optional[str] = None):
    """初始化：拉取索引和日志。可选指定 space_id。"""
    global _CACHE_READY, _ATEXIT_REGISTERED, _INDEX_LAST_REFRESH

    if space_id:
        config = Path(".feishu-config.json")
        cfg = {}
        if config.exists():
            try:
                cfg = json.loads(config.read_text(encoding="utf-8"))
            except Exception:
                pass
        cfg["space_id"] = space_id
        config.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    _build_index()
    _INDEX_LAST_REFRESH = _time.time()
    _CACHE_READY = True

    if not _ATEXIT_REGISTERED:
        atexit.register(_atexit_sync)
        _ATEXIT_REGISTERED = True


def _ensure_cache() -> None:
    """确保索引可用。幂等。"""
    global _CACHE_READY, _ATEXIT_REGISTERED, _INDEX_LAST_REFRESH
    if _CACHE_READY:
        return

    if not INDEX_FILE.exists() or not STATE_FILE.exists():
        _build_index()
        _INDEX_LAST_REFRESH = _time.time()
    else:
        DOCS_DIR.mkdir(parents=True, exist_ok=True)

    _CACHE_READY = True

    if not _ATEXIT_REGISTERED:
        atexit.register(_atexit_sync)
        _ATEXIT_REGISTERED = True


def _atexit_sync():
    """Python 进程退出时自动 sync dirty 页面。"""
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
    """按标题查找页面。精确匹配优先，回退到包含匹配。自动刷新过期索引。"""
    _ensure_cache()
    index = _refresh_index_if_stale()
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
    """列出所有页面（可按分类过滤）。自动刷新过期索引。"""
    _ensure_cache()
    index = _refresh_index_if_stale()
    result = []
    for title, info in index.get("pages", {}).items():
        if category is None or info.get("category") == category:
            result.append({"title": title, **info})
    return result


def exists(title: str) -> bool:
    """严格精确匹配，不做模糊查找。"""
    _ensure_cache()
    index = _refresh_index_if_stale()
    return title in index.get("pages", {})


def fetch(page_or_title, fresh: bool = False) -> str:
    """读取页面正文。

    默认使用本地缓存（如果 edit_time 未变）。
    fresh=True 时强制从飞书拉取最新版本。
    """
    _ensure_cache()
    if isinstance(page_or_title, dict):
        title = page_or_title.get("title", "")
    else:
        title = page_or_title

    index = _refresh_index_if_stale()
    page_info = index.get("pages", {}).get(title)
    if not page_info:
        page_info = find(title)
        if not page_info:
            raise ValueError(f"找不到页面: {title}")
        title = page_info.get("title", title)

    path = _doc_cache_path(title)
    obj_token = page_info.get("obj_token", "")

    if not fresh and path.exists():
        # 检查 edit_time 是否一致（索引中的 vs 缓存时记录的）
        state = _load_state()
        cached_times = state.get("cached_edit_times", {})
        if cached_times.get(title) == page_info.get("obj_edit_time", ""):
            return path.read_text(encoding="utf-8")

    # 拉取最新
    if not obj_token:
        raise ValueError(f"页面 {title} 没有 obj_token")
    md = _fetch_doc_markdown(obj_token)
    path.write_text(md, encoding="utf-8")

    # 记录缓存的 edit_time
    state = _load_state()
    state.setdefault("cached_edit_times", {})[title] = page_info.get("obj_edit_time", "")
    _save_state(state)

    return md


def link(page_or_title) -> str:
    """返回页面的飞书 URL。"""
    _ensure_cache()
    if isinstance(page_or_title, dict):
        url = page_or_title.get("url", "")
        title = page_or_title.get("title", "")
    else:
        title = page_or_title
        page = find(title)
        if not page:
            raise ValueError(f"找不到页面: {title}")
        url = page.get("url", "")

    if not url:
        raise ValueError(f"页面 {title} 没有 URL")
    return url


# === attribution callout ===


_CALLOUT_RE = re.compile(
    r'<callout emoji="(?:👤|bust_in_silhouette|member|user)"[^>]*>.*?</callout>',
    re.DOTALL,
)


def _make_attribution_callout(created_by: dict, updated_by: dict, created_at: str, updated_at: str) -> str:
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
    m = re.search(
        r'<callout emoji="(?:👤|bust_in_silhouette)"[^>]*>(.*?)</callout>',
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
    user = _current_user()
    today = datetime.now().strftime("%Y-%m-%d")

    existing = _extract_attribution(content)
    if existing and existing.get("created_name"):
        created = {"name": existing["created_name"]}
        created_at = existing.get("created_date", today)
    else:
        created = user
        created_at = today

    new_callout = _make_attribution_callout(created, user, created_at, today)

    if existing:
        return re.sub(
            r'<callout emoji="(?:👤|bust_in_silhouette)"[^>]*>.*?</callout>',
            new_callout, content, count=1, flags=re.DOTALL,
        )
    else:
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


def _check_write_permission():
    """检查当前用户是否有写权限。"""
    from feishu_wiki.onboarding import is_write_enabled
    if not is_write_enabled():
        raise PermissionError(
            "当前为学习模式（只读），不能修改维基。\n"
            "如需切换到贡献模式，运行：feishu-wiki mode write"
        )


def _upload_page(title: str, obj_token: str, content: str) -> None:
    """立即上传单个页面到飞书。"""
    r = _run_lark(
        ["docs", "+update", "--as", "user",
         "--doc", obj_token,
         "--mode", "overwrite",
         "--markdown", content],
        check=True,
    )
    if not _is_success(r):
        raise RuntimeError(f"上传失败 {title}: {r}")


def create(category: str, title: str, content: str, summary: str = "") -> dict:
    """
    在指定分类下创建新页面。

    如果在 fw.lock() 上下文中，锁已持有。
    否则自动获取/释放锁。
    """
    from feishu_wiki.lock import _is_locked, lock

    _check_write_permission()
    _ensure_cache()

    if category not in ALL_CATEGORIES and category != "原始资料":
        raise ValueError(f"无效分类: {category}，可选: {ALL_CATEGORIES}")
    if exists(title):
        raise ValueError(f"页面已存在: {title}（请用 update）")

    def _do_create():
        index = _load_index()
        container = index["containers"].get(category)
        if not container:
            raise ValueError(f"找不到分类容器: {category}")
        parent_token = container["node_token"]

        # 插入 attribution callout
        attributed_content = _upsert_attribution(content, is_create=True)

        r = _run_lark(
            ["docs", "+create", "--as", "user",
             "--wiki-node", parent_token,
             "--title", title,
             "--markdown", attributed_content],
            check=True,
        )
        if not _is_success(r):
            raise RuntimeError(f"create 失败: {r}")

        data = r.get("data", {})
        doc_id = data.get("doc_id")
        doc_url = data.get("doc_url", "")
        node_token = doc_url.split("/")[-1] if "/wiki/" in doc_url else ""

        # 本地缓存
        _doc_cache_path(title).write_text(attributed_content, encoding="utf-8")

        new_page = {
            "category": category,
            "parent_token": parent_token,
            "node_token": node_token,
            "obj_token": doc_id,
            "url": doc_url,
            "obj_edit_time": "",
            "summary": summary,
        }
        index.setdefault("pages", {})[title] = new_page
        _save_index(index)

        # 记录 cached_edit_time
        state = _load_state()
        state.setdefault("cached_edit_times", {})[title] = ""
        _save_state(state)

        append_log(f"创建 | {title}", details=f"分类：{category}")
        return {"title": title, **new_page}

    if _is_locked():
        return _do_create()
    else:
        with lock():
            return _do_create()


def update(page_or_title, content: str, mode: str = "append", summary: str = "") -> None:
    """
    更新页面。自动获取锁 → 拉最新 → 修改 → 上传 → 释放锁。

    如果在 fw.lock() 上下文中，锁已持有，不会重复获取。
    mode: append（推荐）/ overwrite
    """
    from feishu_wiki.lock import _is_locked, lock

    _check_write_permission()
    _ensure_cache()

    if isinstance(page_or_title, dict):
        title = page_or_title.get("title", "")
    else:
        title = page_or_title

    def _do_update():
        page = find(title)
        if not page:
            raise ValueError(f"找不到页面: {title}")

        # 拉取最新版本
        current = fetch(title, fresh=True)

        if mode == "append":
            new_content = current.rstrip() + "\n\n" + content
        elif mode == "overwrite":
            new_content = content
        else:
            raise ValueError(f"不支持的 mode: {mode}")

        # 更新 attribution
        new_content = _upsert_attribution(new_content, is_create=False)

        # 立即上传
        obj_token = page.get("obj_token", "")
        if not obj_token:
            raise ValueError(f"页面 {title} 没有 obj_token")
        _upload_page(title, obj_token, new_content)

        # 更新本地缓存
        _doc_cache_path(title).write_text(new_content, encoding="utf-8")

        # 更新索引中的 summary（如果提供了）
        if summary:
            index = _load_index()
            if title in index.get("pages", {}):
                index["pages"][title]["summary"] = summary
                _save_index(index)

        append_log(f"更新 | {title}", details=f"mode={mode}")

    if _is_locked():
        _do_update()
    else:
        with lock():
            _do_update()


# === 日志 ===


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


# === 同步 ===


def _refetch_edit_times(obj_tokens: list) -> dict:
    """重新拉取指定页面的 obj_edit_time。"""
    result = {}
    if not obj_tokens:
        return result

    index = _load_index()
    space_id = index["space_id"]
    target_set = set(obj_tokens)

    token_to_parent = {}
    for title, p in index.get("pages", {}).items():
        ot = p.get("obj_token", "")
        pt = p.get("parent_token", "")
        if ot in target_set and pt:
            token_to_parent[ot] = pt

    for name, info in index.get("special_docs", {}).items():
        ot = info.get("obj_token", "")
        if ot in target_set:
            token_to_parent[ot] = index["root"]["node_token"]

    parents_to_scan = set(token_to_parent.values())
    try:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            futures = {ex.submit(_list_children, pt, space_id): pt for pt in parents_to_scan}
            for future in as_completed(futures):
                for child in future.result():
                    ot = child.get("obj_token", "")
                    if ot in target_set:
                        result[ot] = child.get("obj_edit_time", "")
    except RuntimeError:
        for parent_token in parents_to_scan:
            for child in _list_children(parent_token, space_id):
                ot = child.get("obj_token", "")
                if ot in target_set:
                    result[ot] = child.get("obj_edit_time", "")

    return result


def sync() -> dict:
    """同步本地 dirty 变更（日志）到飞书。普通页面已在 update 时立即上传。"""
    with _SYNC_LOCK:
        state = _load_state()
        dirty_log = state.get("dirty_log", False)

        if not dirty_log:
            return {"uploaded": 0}

        index = _load_index()
        uploaded = 0

        if dirty_log and "日志" in index.get("special_docs", {}):
            log_info = index["special_docs"]["日志"]
            content = LOG_FILE.read_text(encoding="utf-8") if LOG_FILE.exists() else "# 日志\n"
            _upload_page("日志", log_info["obj_token"], content)
            uploaded += 1

        state["dirty_log"] = False
        state["last_sync_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        _save_state(state)

        print(f"[fw] ✓ 已同步 {uploaded} 项", file=sys.stderr, flush=True)
        return {"uploaded": uploaded}


def refresh() -> None:
    """强制重建索引。"""
    global _CACHE_READY, _INDEX_LAST_REFRESH
    sync()
    _CACHE_READY = False
    _INDEX_LAST_REFRESH = 0
    _build_index()
    _INDEX_LAST_REFRESH = _time.time()
    _CACHE_READY = True


def status() -> dict:
    """查看当前缓存状态。"""
    if not INDEX_FILE.exists():
        return {"cache": "missing"}
    index = _load_index()
    state = _load_state()
    return {
        "cache": "ready",
        "built_at": index.get("built_at"),
        "pages": len(index.get("pages", {})),
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
