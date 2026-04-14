"""
feishu_wiki.lock —— 基于飞书 Queue 页面的分布式 FIFO 写锁

机制：
  - 飞书知识库中有一个特殊页面「队列」作为 FIFO 锁
  - 每行格式：name|timestamp
  - 队首 = 持锁人
  - 写入前：追加自己到队尾 → 轮询（15s）直到自己在队首
  - 写完后：移除自己（队首）
  - 超时 5 分钟的条目自动清理（防死锁）

用法：
    with fw.lock():
        fw.create(...)
        fw.update(...)
"""

import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone

from feishu_wiki.core import (
    _run_lark, _is_success, _current_user, _load_index,
    _fetch_doc_markdown, _ensure_cache,
)

# 锁配置
POLL_INTERVAL = 15     # 轮询间隔（秒）
LOCK_TIMEOUT = 300     # 锁超时（秒，5 分钟）

# 会话级锁状态
_LOCK_HELD = False


def _is_locked() -> bool:
    """当前进程是否持有锁。"""
    return _LOCK_HELD


def _get_queue_info() -> dict:
    """获取 Queue 页面的 obj_token。如果不存在则创建。"""
    _ensure_cache()
    index = _load_index()

    # 检查 special_docs 里是否有队列
    if "队列" in index.get("special_docs", {}):
        return index["special_docs"]["队列"]

    # 检查 pages 里
    pages = index.get("pages", {})
    if "队列" in pages:
        return pages["队列"]

    # 需要创建 Queue 页面
    root = index.get("root", {})
    root_node_token = root.get("node_token")
    if not root_node_token:
        raise RuntimeError("无法找到 wiki root node，无法创建队列页面")

    r = _run_lark(
        ["docs", "+create", "--as", "user",
         "--wiki-node", root_node_token,
         "--title", "队列",
         "--markdown", "# 写入队列\n\n"],
        check=True,
    )
    if not _is_success(r):
        raise RuntimeError(f"创建队列页面失败: {r}")

    data = r.get("data", {})
    doc_id = data.get("doc_id")
    doc_url = data.get("doc_url", "")
    node_token = doc_url.split("/")[-1] if "/wiki/" in doc_url else ""

    queue_info = {
        "obj_token": doc_id,
        "node_token": node_token,
        "url": doc_url,
    }

    # 写入索引
    index.setdefault("special_docs", {})["队列"] = queue_info
    from feishu_wiki.core import _save_index
    _save_index(index)

    print("[fw] 已创建队列页面", file=sys.stderr, flush=True)
    return queue_info


def _read_queue(obj_token: str) -> list:
    """从飞书拉取 Queue 页面，解析为 [(name, timestamp_str), ...]。"""
    md = _fetch_doc_markdown(obj_token)
    entries = []
    for line in md.strip().split("\n"):
        line = line.strip()
        if "|" in line and not line.startswith("#"):
            parts = line.split("|", 1)
            if len(parts) == 2:
                entries.append((parts[0].strip(), parts[1].strip()))
    return entries


def _write_queue(obj_token: str, entries: list) -> None:
    """覆盖写入 Queue 页面。"""
    lines = ["# 写入队列\n"]
    for name, ts in entries:
        lines.append(f"{name}|{ts}")
    content = "\n".join(lines) + "\n"

    r = _run_lark(
        ["docs", "+update", "--as", "user",
         "--doc", obj_token,
         "--mode", "overwrite",
         "--markdown", content],
        check=True,
    )
    if not _is_success(r):
        raise RuntimeError(f"写入队列失败: {r}")


def _clean_expired(entries: list) -> list:
    """移除超过 LOCK_TIMEOUT 的条目。"""
    now = datetime.now(timezone.utc)
    cleaned = []
    for name, ts in entries:
        try:
            entry_time = datetime.fromisoformat(ts)
            if (now - entry_time).total_seconds() < LOCK_TIMEOUT:
                cleaned.append((name, ts))
            else:
                print(f"[fw] 锁超时，自动清理: {name} ({ts})", file=sys.stderr, flush=True)
        except (ValueError, TypeError):
            # 无法解析时间戳，跳过
            continue
    return cleaned


def _acquire(obj_token: str, user_name: str) -> None:
    """获取锁：追加自己到队尾，等待直到自己在队首。"""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # 读取当前队列，清理过期，追加自己
    entries = _read_queue(obj_token)
    entries = _clean_expired(entries)
    entries.append((user_name, now))
    _write_queue(obj_token, entries)

    # 轮询等待
    while True:
        entries = _read_queue(obj_token)
        entries = _clean_expired(entries)

        if not entries:
            # 队列为空（可能被清理了），重新加入
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            entries.append((user_name, now))
            _write_queue(obj_token, entries)
            continue

        if entries[0][0] == user_name:
            # 自己在队首，获得锁
            print(f"[fw] 🔒 已获取写锁 ({user_name})", file=sys.stderr, flush=True)
            return

        # 自己不在队首，等待
        print(
            f"[fw] 等待写锁... 队列: {[e[0] for e in entries]}",
            file=sys.stderr, flush=True,
        )
        time.sleep(POLL_INTERVAL)


def _release(obj_token: str, user_name: str) -> None:
    """释放锁：从队首移除自己。"""
    entries = _read_queue(obj_token)
    entries = _clean_expired(entries)

    if entries and entries[0][0] == user_name:
        entries.pop(0)
    else:
        # 自己不在队首，可能超时被清理了，尝试移除任何位置的自己
        entries = [(n, t) for n, t in entries if n != user_name]

    _write_queue(obj_token, entries)
    print(f"[fw] 🔓 已释放写锁 ({user_name})", file=sys.stderr, flush=True)


@contextmanager
def lock():
    """分布式写锁上下文管理器。

    用法：
        with fw.lock():
            fw.create(...)
            fw.update(...)
    """
    global _LOCK_HELD

    if _LOCK_HELD:
        # 已经持有锁（嵌套调用），直接执行
        yield
        return

    _ensure_cache()
    queue_info = _get_queue_info()
    obj_token = queue_info["obj_token"]
    user = _current_user()
    user_name = user.get("name", "unknown")

    _acquire(obj_token, user_name)
    _LOCK_HELD = True

    try:
        yield
    finally:
        _LOCK_HELD = False
        try:
            # sync 日志
            from feishu_wiki.core import sync
            sync()
        except Exception as e:
            print(f"[fw] 锁内 sync 失败: {e}", file=sys.stderr, flush=True)
        _release(obj_token, user_name)
