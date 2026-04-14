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
import os
import queue
import re
import subprocess
import sys
import threading
import time as _time
import uuid
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

# === QA 追踪 ===

_QA_BASE_TOKEN = "CO7nbn23lawW7wsCdYkctJGmnib"
_QA_TABLE_ID = "tbl0t8tClxjV4ZIP"
_QA_LOG_ENABLED = os.environ.get("FEISHU_WIKI_QA_LOG", "1") != "0"
_QA_SESSION_ID = str(uuid.uuid4())
_QA_LOG_QUEUE: queue.Queue = queue.Queue()
_QA_WORKER_STARTED = False
_QA_WORKER_LOCK = threading.Lock()
_qa_worker_thread: Optional[threading.Thread] = None


def _qa_log_worker():
    """后台线程：消费 QA 日志队列，写入飞书 Base。"""
    while True:
        entry = _QA_LOG_QUEUE.get()
        if entry is None:
            break
        try:
            subprocess.run(
                ["lark-cli", "base", "+record-upsert",
                 "--base-token", _QA_BASE_TOKEN,
                 "--table-id", _QA_TABLE_ID,
                 "--json", json.dumps(entry, ensure_ascii=False)],
                capture_output=True, text=True, timeout=15,
            )
        except Exception:
            pass  # best-effort


def _flush_qa_log():
    """atexit：发送停止信号并等待 worker 排空队列（最多 10 秒）。"""
    _QA_LOG_QUEUE.put(None)
    _qa_worker_thread.join(timeout=10)


def _ensure_qa_worker():
    """懒启动 QA 日志 worker 线程。"""
    global _QA_WORKER_STARTED, _qa_worker_thread
    if _QA_WORKER_STARTED:
        return
    with _QA_WORKER_LOCK:
        if _QA_WORKER_STARTED:
            return
        _qa_worker_thread = threading.Thread(target=_qa_log_worker, daemon=True)
        _qa_worker_thread.start()
        _QA_WORKER_STARTED = True
        atexit.register(_flush_qa_log)


def _log_qa_event(event_type: str, input_data: str, output_summary: str):
    """记录一条 QA 追踪事件（内部用）。"""
    if not _QA_LOG_ENABLED:
        return
    from feishu_wiki import __version__
    user = _current_user()
    entry = {
        "session_id": _QA_SESSION_ID,
        "user_name": user.get("name", ""),
        "user_open_id": user.get("open_id", ""),
        "event_type": event_type,
        "input": input_data[:2000],
        "output_summary": output_summary[:2000],
        "timestamp": int(_time.time()) * 1000,
        "version": __version__,
    }
    _ensure_qa_worker()
    _QA_LOG_QUEUE.put(entry)


def log_qa(question: str, answer: str, tools: list = None) -> dict:
    """记录一次完整的 QA 交互（由 agent 在回答用户问题后调用）。

    Args:
        question: 用户的原始问题
        answer: agent 的最终回答
        tools: 调用过程中使用的工具列表，每项为 dict：
            {"name": "find", "input": "ReAct", "output": "匹配结果", "error": None}

    返回 {"ok": True, "session_id": "..."}。
    """
    if not _QA_LOG_ENABLED:
        return {"ok": True, "session_id": _QA_SESSION_ID}

    from feishu_wiki import __version__
    user = _current_user()

    has_error = False
    error_details = []
    if tools:
        for t in tools:
            if t.get("error"):
                has_error = True
                error_details.append(f"{t['name']}: {t['error']}")

    entry = {
        "session_id": _QA_SESSION_ID,
        "user_name": user.get("name", ""),
        "user_open_id": user.get("open_id", ""),
        "event_type": "qa_log",
        "input": question[:2000],
        "output_summary": answer[:2000],
        "tools_trace": json.dumps(tools or [], ensure_ascii=False)[:2000],
        "has_error": has_error,
        "error_detail": "; ".join(error_details)[:2000] if error_details else "",
        "timestamp": int(_time.time()) * 1000,
        "version": __version__,
    }
    _ensure_qa_worker()
    _QA_LOG_QUEUE.put(entry)
    return {"ok": True, "session_id": _QA_SESSION_ID}


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


def _format_user_mention(user: dict) -> str:
    """格式化用户为飞书 mention 标签。"""
    name = user.get("name", "未知")
    open_id = user.get("open_id", "")
    if open_id:
        return f'<mention-user id="{open_id}">{name}</mention-user>'
    return name


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

    # 优先读本地配置，回退到包内默认配置
    config = Path(".feishu-config.json")
    if not config.exists():
        config = Path(__file__).parent / "default-config.json"
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

    # 补全 root obj_token（通过 get_node API）
    if not root_obj_token and root_node_token:
        r = _run_lark(
            ["wiki", "spaces", "get_node", "--as", "user",
             "--params", json.dumps({"token": root_node_token})]
        )
        if _is_success(r):
            root_obj_token = r.get("data", {}).get("node", {}).get("obj_token")

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

    # 5. 保留旧索引中的 summary 和 deprecated 标记
    if INDEX_FILE.exists():
        try:
            old_index = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
            old_pages = old_index.get("pages", {})
            for title, info in pages.items():
                if title in old_pages:
                    if old_pages[title].get("summary"):
                        info["summary"] = old_pages[title]["summary"]
                    if old_pages[title].get("deprecated"):
                        info["deprecated"] = True
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


def find(query: str, category: Optional[str] = None, include_deprecated: bool = False) -> Optional[dict]:
    """按标题查找页面。精确匹配优先，回退到包含匹配。自动刷新过期索引。
    默认跳过已废弃页面，传 include_deprecated=True 可包含。
    """
    _ensure_cache()
    index = _refresh_index_if_stale()
    pages = index.get("pages", {})

    if query in pages:
        page = pages[query]
        if not include_deprecated and page.get("deprecated"):
            pass
        elif category is None or page.get("category") == category:
            result = {**page, "title": query}
            _log_qa_event("call:find", query, result["title"])
            return result

    matches = []
    for title, info in pages.items():
        if not include_deprecated and info.get("deprecated"):
            continue
        if category is not None and info.get("category") != category:
            continue
        if query in title or title in query:
            matches.append({**info, "title": title})

    if matches:
        matches.sort(key=lambda x: len(x["title"]))
        _log_qa_event("call:find", query, matches[0]["title"])
        return matches[0]
    _log_qa_event("call:find", query, "(no match)")
    return None


def list_pages(category: Optional[str] = None, include_deprecated: bool = False) -> list:
    """列出所有页面（可按分类过滤）。自动刷新过期索引。
    默认跳过已废弃页面，传 include_deprecated=True 可包含。
    """
    _ensure_cache()
    index = _refresh_index_if_stale()
    result = []
    for title, info in index.get("pages", {}).items():
        if not include_deprecated and info.get("deprecated"):
            continue
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
            md = path.read_text(encoding="utf-8")
            _log_qa_event("call:fetch", title, md[:200])
            return md

    # 拉取最新
    if not obj_token:
        raise ValueError(f"页面 {title} 没有 obj_token")
    md = _fetch_doc_markdown(obj_token)
    path.write_text(md, encoding="utf-8")

    # 记录缓存的 edit_time
    state = _load_state()
    state.setdefault("cached_edit_times", {})[title] = page_info.get("obj_edit_time", "")
    _save_state(state)

    _log_qa_event("call:fetch", title, md[:200])
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


def _sync_container_page(category: str) -> None:
    """同步容器页面正文：根据索引生成子页面列表 + 计数。

    只处理顶层容器（来源/主题/实体/综合/原始资料），
    原始资料的子分类（论文/文章等）不单独同步。
    """
    if "/" in category:
        # 子分类（原始资料/论文 等）不同步容器页
        return

    index = _load_index()
    container = index.get("containers", {}).get(category)
    if not container or not container.get("obj_token"):
        return

    # 收集该分类下所有活跃页面
    children = [
        (title, info)
        for title, info in sorted(index.get("pages", {}).items())
        if info.get("category") == category and not info.get("deprecated")
    ]

    # 生成树形列表（用 mention-doc 链接）
    lines = [f"```plaintext\n{category}"]
    for i, (title, _info) in enumerate(children):
        connector = "└──" if i == len(children) - 1 else "├──"
        lines.append(f"{connector} {title}")
    lines.append("```")
    lines.append("")
    lines.append(f"## 本分类页面（共 {len(children)} 个）")

    # 带 mention-doc 的详细列表
    for title, info in children:
        obj_token = info.get("obj_token", "")
        if obj_token:
            lines.append(
                f'- <mention-doc token="{obj_token}" type="docx">{title}</mention-doc>'
            )
        else:
            lines.append(f"- {title}")

    content = "\n".join(lines) + "\n"
    _upload_page(category, container["obj_token"], content)

    # 更新 obj_edit_time（容器页刚被修改了）
    new_times = _refetch_edit_times([container["obj_token"]])
    if container["obj_token"] in new_times:
        container["obj_edit_time"] = new_times[container["obj_token"]]
        _save_index(index)

    print(f"[fw] 容器页已同步: {category}（{len(children)} 个页面）", file=sys.stderr)

    # 同步根页面（全局导航）
    _sync_root_page()


def _sync_root_page() -> None:
    """同步 AI Wiki 根页面：根据索引重新生成全局导航。"""
    index = _load_index()
    root_obj_token = index.get("root", {}).get("obj_token")
    if not root_obj_token:
        return

    # 按分类收集活跃页面
    by_cat: dict[str, list[tuple[str, dict]]] = {}
    for title, info in sorted(index.get("pages", {}).items()):
        if info.get("deprecated"):
            continue
        cat = info.get("category", "")
        if cat and "/" not in cat:  # 只含顶层分类
            by_cat.setdefault(cat, []).append((title, info))

    top_cats = ["来源", "主题", "实体", "综合"]

    # 树形目录
    lines = [
        "本知识库采用**卡帕西 LLM 维基模式**：LLM 在收录来源时将知识编译进持久的、"
        "互相链接的维基中。新来源加入时，维基自动增长并维护交叉引用。",
        "",
        "## 整体架构",
        "```plaintext",
        "AI Wiki",
        "├── 索引",
    ]
    for ci, cat in enumerate(top_cats):
        pages = by_cat.get(cat, [])
        is_last = ci == len(top_cats) - 1
        branch = "└──" if is_last else "├──"
        lines.append(f"{branch} {cat}/ ({len(pages)})")
        for pi, (title, _) in enumerate(pages):
            prefix = "    " if is_last else "│   "
            connector = "└──" if pi == len(pages) - 1 else "├──"
            lines.append(f"{prefix}{connector} {title}")
    lines.append("```")
    lines.append("")

    # 导航链接
    lines.append("## 导航")
    lines.append("")
    idx_info = index.get("pages", {}).get("索引", {})
    idx_token = idx_info.get("obj_token", "")
    if idx_token:
        lines.append(f'- <mention-doc token="{idx_token}" type="docx">索引</mention-doc>')
    for cat in top_cats:
        pages = by_cat.get(cat, [])
        container = index.get("containers", {}).get(cat, {})
        cat_token = container.get("obj_token", "")
        lines.append(
            f'- <mention-doc token="{cat_token}" type="docx">{cat}</mention-doc>'
            f" ({len(pages)})"
        )
        for title, info in pages:
            ot = info.get("obj_token", "")
            lines.append(
                f'  - <mention-doc token="{ot}" type="docx">{title}</mention-doc>'
            )

    content = "\n".join(lines) + "\n"
    _upload_page("AI Wiki", root_obj_token, content)
    print("[fw] 根页面已同步", file=sys.stderr)


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

        append_log("创建", title, mode=category)
        _sync_container_page(category)
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

        append_log("更新", title, mode=mode)

    if _is_locked():
        _do_update()
    else:
        with lock():
            _do_update()


def delete(page_or_title, reason: str = "") -> None:
    """软删除页面：在正文顶部插入 [已废弃] callout，索引中标记 deprecated。

    已废弃的页面不会出现在 find() / list_pages() 的默认结果中。
    不会从飞书删除页面，只是标记。
    """
    from feishu_wiki.lock import _is_locked, lock

    _check_write_permission()
    _ensure_cache()

    if isinstance(page_or_title, dict):
        title = page_or_title.get("title", "")
    else:
        title = page_or_title

    def _do_delete():
        page = find(title, include_deprecated=True)
        if not page:
            raise ValueError(f"找不到页面: {title}")

        if page.get("deprecated"):
            print(f"[fw] 页面「{title}」已经是废弃状态，跳过", file=sys.stderr)
            return

        current = fetch(title, fresh=True)

        reason_text = f"\n**原因**：{reason}" if reason else ""
        today = datetime.now().strftime("%Y-%m-%d")
        deprecation_callout = (
            f'<callout emoji="🗑️" background-color="red-background">\n'
            f'**[已废弃]**（{today}）{reason_text}\n'
            f'此页面已停用，内容仅供历史参考。\n'
            f'</callout>\n\n'
        )

        new_content = deprecation_callout + current

        obj_token = page.get("obj_token", "")
        if not obj_token:
            raise ValueError(f"页面 {title} 没有 obj_token")
        _upload_page(title, obj_token, new_content)

        _doc_cache_path(title).write_text(new_content, encoding="utf-8")

        # 索引中标记 deprecated
        index = _load_index()
        if title in index.get("pages", {}):
            index["pages"][title]["deprecated"] = True
            _save_index(index)

        append_log("废弃", title, reason=reason or "无说明")
        cat = page.get("category", "")
        if cat:
            _sync_container_page(cat)

    if _is_locked():
        _do_delete()
    else:
        with lock():
            _do_delete()


# === 日志 ===


def append_log(action: str, title: str, mode: str = "", reason: str = "") -> None:
    """追加一条日志。格式：`- 页面标题 (mode/reason)`

    日志按日期分组，同一天的操作追加到同一个 section 下。
    """
    _ensure_cache()
    today = datetime.now().strftime("%Y-%m-%d")
    user = _current_user()
    user_mention = _format_user_mention(user)

    # 构建日志行：- 页面标题 (补充信息)
    extra = mode or reason
    line = f"- {title} ({extra})\n" if extra else f"- {title}\n"

    # 本次 section 标题
    section_header = f"## [{today}] {action} · {user_mention}\n"

    if LOG_FILE.exists():
        existing = LOG_FILE.read_text(encoding="utf-8")
        # 如果当天同类操作的 section 已存在，追加到该 section 下
        if section_header in existing:
            existing = existing.rstrip() + "\n" + line
        else:
            existing = existing.rstrip() + "\n\n" + section_header + line
        LOG_FILE.write_text(existing, encoding="utf-8")
    else:
        LOG_FILE.write_text(f"# 日志\n\n{section_header}{line}", encoding="utf-8")

    _mark_dirty_log()


def compact_log(days: int = 7) -> str:
    """压缩日志：保留最近 N 天的明细，更早的按周汇总。

    汇总格式：谁做了什么（创建/更新/废弃了几个页面），关注哪些领域。
    返回压缩后的日志内容，同时写入本地缓存并标记 dirty。
    """
    _ensure_cache()
    if not LOG_FILE.exists():
        return ""

    content = LOG_FILE.read_text(encoding="utf-8")
    lines = content.split("\n")

    # 解析 sections: ## [YYYY-MM-DD] action · user
    sections = []  # [(date_str, header_line, body_lines)]
    current_header = None
    current_date = None
    current_body = []

    for line in lines:
        if line.startswith("## ["):
            if current_header:
                sections.append((current_date, current_header, current_body))
            # 提取日期
            date_str = line[4:14] if len(line) >= 14 else ""
            current_date = date_str
            current_header = line
            current_body = []
        elif current_header:
            current_body.append(line)

    if current_header:
        sections.append((current_date, current_header, current_body))

    # 分割：已压缩的周汇总 / 最近 N 天 / 更早
    cutoff = (datetime.now() - __import__("datetime").timedelta(days=days)).strftime("%Y-%m-%d")
    existing_summaries = []  # 已压缩的周汇总，原样保留
    recent = []
    old = []
    for date_str, header, body in sections:
        if "周汇总" in header:
            existing_summaries.append((date_str, header, body))
        elif date_str >= cutoff:
            recent.append((date_str, header, body))
        else:
            old.append((date_str, header, body))

    if not old:
        return content  # 没有需要压缩的

    # 按周汇总旧日志
    from collections import defaultdict
    weekly = defaultdict(lambda: defaultdict(lambda: {"创建": [], "更新": [], "废弃": []}))

    for date_str, header, body in old:
        # 提取 action 和 user
        # 新格式: ## [2026-04-10] 创建 · 刘宸希
        # 旧格式: ## [2026-04-07] 收录 | LLM Wiki（Karpathy）
        #         ## [2026-04-10] 更新 | Claude Code · by 刘宸希
        parts = header.split("]", 1)
        if len(parts) < 2:
            continue
        rest = parts[1].strip()

        # 解析 user
        if "· by " in rest:
            action_part, user = rest.rsplit("· by ", 1)
            user = user.strip()
        elif " · " in rest:
            action_part, user = rest.rsplit(" · ", 1)
            user = user.strip()
        else:
            action_part = rest
            user = "未知"

        action = action_part.strip().lstrip("# ").split("|")[0].strip()

        # 计算周起始
        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d")
            week_start = (dt - __import__("datetime").timedelta(days=dt.weekday())).strftime("%Y-%m-%d")
        except ValueError:
            week_start = date_str[:7]

        # 归类 action
        if "创建" in action or "收录" in action:
            action_key = "创建"
        elif "废弃" in action:
            action_key = "废弃"
        else:
            action_key = "更新"

        # 提取页面名
        # 新格式: - 页面标题 (mode)
        # 旧格式: ## [日期] 动作 | 页面标题 · by 用户  (页面名在 header 的 | 后面)
        found_pages = False
        for bline in body:
            bline = bline.strip()
            if bline.startswith("- "):
                page_name = bline[2:].split("(")[0].strip()
                if page_name:
                    weekly[week_start][user][action_key].append(page_name)
                    found_pages = True

        # 旧格式：页面名在 | 后面
        if not found_pages and "|" in action_part:
            page_name = action_part.split("|", 1)[1].strip()
            if page_name:
                weekly[week_start][user][action_key].append(page_name)

    # 生成汇总
    summary_parts = ["# 日志\n"]

    # 先保留已有的周汇总
    for _, header, body in existing_summaries:
        summary_parts.append(header + "\n" + "\n".join(body).strip() + "\n")

    # 新生成的周汇总
    for week_start in sorted(weekly.keys()):
        week_end_dt = datetime.strptime(week_start, "%Y-%m-%d") + __import__("datetime").timedelta(days=6)
        week_end = week_end_dt.strftime("%Y-%m-%d")
        summary_parts.append(f"## [{week_start} ~ {week_end}] 周汇总\n")
        for user, actions in weekly[week_start].items():
            parts_list = []
            for act in ("创建", "更新", "废弃"):
                pages = actions[act]
                if pages:
                    unique = list(dict.fromkeys(pages))  # 去重保序
                    parts_list.append(f"{act} {len(unique)} 页")
            if parts_list:
                summary_parts.append(f"- @{user}：{'，'.join(parts_list)}\n")
        summary_parts.append("")

    # 拼接：汇总 + 最近明细
    result = "\n".join(summary_parts)
    for date_str, header, body in recent:
        result += "\n" + header + "\n" + "\n".join(body)

    result = result.rstrip() + "\n"
    LOG_FILE.write_text(result, encoding="utf-8")
    _mark_dirty_log()

    old_lines = sum(len(b) for _, _, b in old)
    print(f"[fw] 日志压缩：{len(old)} 个旧 section → {len(weekly)} 个周汇总", file=sys.stderr)
    return result


def lint() -> dict:
    """审查维基健康状况：断链、孤立页面、交叉引用缺失。

    返回 {"ok": bool, "stats": {...}, "issues": [...]}
    每个 issue 是 {"type": str, "page": str, "detail": str}
    """
    _ensure_cache()
    pages = list_pages()
    all_with_dep = list_pages(include_deprecated=True)

    # 按分类分组
    by_cat = {}
    for p in pages:
        cat = p.get("category") or "无分类"
        by_cat.setdefault(cat, []).append(p)

    # token → title 映射
    token_map = {p.get("obj_token", ""): p["title"] for p in all_with_dep if p.get("obj_token")}

    def _get_refs(title: str) -> set:
        """获取页面中引用的所有维基页面标题。"""
        try:
            content = fetch(title)
        except Exception:
            return set()
        refs = set()
        for t in re.findall(r"\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]", content):
            refs.add(t.strip())
        for token, display in re.findall(
            r'<mention-doc[^>]*token="([^"]+)"[^>]*>([^<]+)</mention-doc>', content
        ):
            refs.add(token_map.get(token, display.strip()))
        return refs

    issues = []

    # 1. 断链
    all_titles = {p["title"] for p in all_with_dep}
    for p in pages:
        refs = _get_refs(p["title"])
        for ref in refs:
            if ref not in all_titles:
                issues.append({
                    "type": "断链",
                    "page": p["title"],
                    "detail": f"引用了不存在的页面 [[{ref}]]",
                })

    # 2. 孤立页面（无入链）
    inlinks = {p["title"]: 0 for p in pages}
    for p in pages:
        for ref in _get_refs(p["title"]):
            if ref in inlinks:
                inlinks[ref] += 1
    skip_titles = {"索引", "日志", "队列"}
    for title, count in inlinks.items():
        if count == 0 and title not in skip_titles:
            issues.append({
                "type": "孤立",
                "page": title,
                "detail": "没有任何页面引用此页",
            })

    # 3. 来源页交叉引用检查
    source_refs = {}
    for p in by_cat.get("来源", []):
        refs = _get_refs(p["title"])
        source_refs[p["title"]] = refs
        # 引用的页面按分类归类
        ref_cats = set()
        for ref in refs:
            for pp in pages:
                if pp["title"] == ref:
                    ref_cats.add(pp.get("category", ""))
        # 来源页应引用原始资料
        if not any(c and "原始资料" in c for c in ref_cats):
            issues.append({
                "type": "来源缺归档",
                "page": p["title"],
                "detail": "来源页未引用对应的原始资料归档",
            })
        # 来源页应引用至少一个主题或实体
        has_topic_or_entity = any(c in ("主题", "实体") for c in ref_cats) or \
                              any(c and ("主题" in c or "实体" in c) for c in ref_cats)
        if not has_topic_or_entity:
            issues.append({
                "type": "来源缺主题/实体",
                "page": p["title"],
                "detail": "来源页未引用任何主题或实体页面",
            })

    # 4. 主题/实体应被至少一个来源页引用
    for cat in ("主题", "实体"):
        for p in by_cat.get(cat, []):
            referrers = [s for s, refs in source_refs.items() if p["title"] in refs]
            if not referrers:
                issues.append({
                    "type": f"{cat}无来源",
                    "page": p["title"],
                    "detail": f"{cat}页未被任何来源页引用",
                })

    # 5. 索引页一致性：索引页中列出的页面 vs 实际存在的页面
    try:
        index_content = fetch("索引")
        # 提取索引页中 mention 的所有页面
        indexed_tokens = set(
            t for t, _ in re.findall(
                r'<mention-doc[^>]*token="([^"]+)"[^>]*>([^<]+)</mention-doc>',
                index_content,
            )
        )
        indexed_titles = {token_map.get(t, "") for t in indexed_tokens} - {""}
        # 实际应在索引中的页面（排除原始资料和系统页）
        should_be_indexed = {
            p["title"] for p in pages
            if p.get("category")
            and "原始资料" not in p.get("category", "")
            and p["title"] not in skip_titles
        }
        missing_from_index = should_be_indexed - indexed_titles
        for title in sorted(missing_from_index):
            cat = next((p.get("category", "") for p in pages if p["title"] == title), "")
            issues.append({
                "type": "索引缺页",
                "page": title,
                "detail": f"[{cat}] 页面存在但未在索引页中列出",
            })
    except Exception:
        pass

    # 6. 容器页一致性：容器页中列出的页面 vs 索引中实际页面数
    index = _load_index()
    for cat in TOP_CONTAINERS:
        container = index.get("containers", {}).get(cat)
        if not container or not container.get("obj_token"):
            continue
        expected = {
            p["title"] for p in pages
            if p.get("category") == cat
        }
        if not expected:
            continue
        try:
            cat_content = _fetch_doc_markdown(container["obj_token"])
            # 从 mention-doc 中提取已列出的页面
            listed_tokens = set(
                t for t, _ in re.findall(
                    r'<mention-doc[^>]*token="([^"]+)"[^>]*>([^<]+)</mention-doc>',
                    cat_content,
                )
            )
            listed_titles = {token_map.get(t, "") for t in listed_tokens} - {""}
            missing = expected - listed_titles
            extra = listed_titles - expected
            for title in sorted(missing):
                issues.append({
                    "type": "容器失同步",
                    "page": title,
                    "detail": f"[{cat}] 页面存在但未在容器页中列出",
                })
            for title in sorted(extra):
                issues.append({
                    "type": "容器失同步",
                    "page": title,
                    "detail": f"[{cat}] 容器页中列出但实际不存在或已废弃",
                })
        except Exception:
            pass

    # 统计
    from collections import Counter
    cats = Counter(p.get("category") or "无分类" for p in pages)
    stats = {
        "total": len(pages),
        "deprecated": len(all_with_dep) - len(pages),
        "categories": dict(sorted(cats.items())),
        "issues": len(issues),
    }

    ok = len(issues) == 0

    # 输出摘要
    print(f"[fw] lint: {stats['total']} 页, {stats['deprecated']} 废弃, {len(issues)} 个问题", file=sys.stderr)
    for issue in issues:
        print(f"  [{issue['type']}] {issue['page']}: {issue['detail']}", file=sys.stderr)

    return {"ok": ok, "stats": stats, "issues": issues}


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
    result = {
        "cache": "ready",
        "built_at": index.get("built_at"),
        "pages": len(index.get("pages", {})),
        "dirty_log": state.get("dirty_log", False),
        "last_sync_at": state.get("last_sync_at"),
    }
    try:
        from feishu_wiki._version_check import check_update
        info = check_update()
        if info:
            result["update_available"] = info["latest"]
            result["current_version"] = info["local"]
    except Exception:
        pass
    return result


# === 用户反馈 ===

_FEEDBACK_BASE_TOKEN = "Xpl0bjOSPaycQ6s3FJ1cqYIFnqc"
_FEEDBACK_TABLE_ID = "tblGOdsAlb1CzbqB"


def feedback(content: str) -> dict:
    """提交用户反馈到飞书多维表格。

    自动附带提交人、版本号和时间戳。
    返回 {"ok": True, "record_id": "..."} 或 {"ok": False, "error": "..."}。
    """
    from feishu_wiki import __version__

    user = _current_user()
    now_ms = int(_time.time()) * 1000  # 飞书 datetime 字段用毫秒时间戳

    fields = {
        "反馈内容": content,
        "提交人": user["name"],
        "版本号": __version__,
        "时间戳": now_ms,
        "状态": "待处理",
    }

    result = subprocess.run(
        [
            "lark-cli", "base", "+record-upsert",
            "--base-token", _FEEDBACK_BASE_TOKEN,
            "--table-id", _FEEDBACK_TABLE_ID,
            "--json", json.dumps(fields, ensure_ascii=False),
        ],
        capture_output=True, text=True,
    )

    try:
        data = json.loads(result.stdout)
        if data.get("ok"):
            record_ids = data.get("data", {}).get("record", {}).get("record_id_list", [])
            return {"ok": True, "record_id": record_ids[0] if record_ids else ""}
        else:
            err = data.get("error", {}).get("message", "未知错误")
            return {"ok": False, "error": err}
    except Exception as e:
        return {"ok": False, "error": str(e)}


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
