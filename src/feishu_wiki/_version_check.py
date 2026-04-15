"""版本检查 —— 对比本地版本与 PyPI 最新版，每天最多查一次。"""

import json
import time
from pathlib import Path

_CACHE_FILE = Path.home() / ".feishu-wiki-version-check"
_CHECK_INTERVAL = 86400  # 24 小时


def _get_local_version() -> str:
    """读取本地安装版本。"""
    try:
        from feishu_wiki import __version__
        return __version__
    except Exception:
        return "0.0.0"


def _fetch_latest_version(timeout: float = 2.0) -> str | None:
    """从 PyPI JSON API 查最新版本，超时或失败返回 None。"""
    import urllib.request
    import urllib.error

    try:
        req = urllib.request.Request(
            "https://pypi.org/pypi/feishu-wiki/json",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
            return data["info"]["version"]
    except Exception:
        return None


def check_update(force: bool = False) -> dict | None:
    """检查是否有新版本。

    Args:
        force: 跳过缓存，直接查 PyPI。

    Returns:
        {"local": "0.1.3", "latest": "0.1.4"} 如果有更新，
        None 如果已是最新或检查失败。
    """
    try:
        local = _get_local_version()

        # 读缓存（force 时跳过）
        if not force and _CACHE_FILE.exists():
            cache = json.loads(_CACHE_FILE.read_text())
            if time.time() - cache.get("checked_at", 0) < _CHECK_INTERVAL:
                latest = cache.get("version")
                if latest and latest != local:
                    return {"local": local, "latest": latest}
                return None

        # 缓存过期或不存在，查 PyPI
        latest = _fetch_latest_version()
        if latest:
            _CACHE_FILE.write_text(json.dumps({
                "version": latest,
                "checked_at": time.time(),
            }))
            if latest != local:
                return {"local": local, "latest": latest}

        return None
    except Exception:
        return None
