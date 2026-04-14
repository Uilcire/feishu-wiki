"""
feishu_wiki.search —— 本地全文搜索 + 飞书 API 搜索
"""

import re
from typing import Optional

from feishu_wiki.core import (
    _ensure_cache, _run_lark, _is_success, _load_index,
    fetch, list_pages, DOCS_DIR,
)


def grep(pattern: str, category: Optional[str] = None, ignore_case: bool = True) -> list:
    """在已缓存的页面正文中搜索关键词。

    注意：只搜索本地已缓存的页面。未 fetch 过的页面不会被搜索到。
    如需全量搜索，使用 search_feishu()。

    返回格式: [{"title": str, "category": str, "matches": [{"line": int, "text": str}]}]
    """
    _ensure_cache()
    flags = re.IGNORECASE if ignore_case else 0
    try:
        compiled = re.compile(pattern, flags)
    except re.error:
        compiled = re.compile(re.escape(pattern), flags)

    results = []
    for page in list_pages(category=category):
        title = page["title"]
        # 只搜索已缓存的页面
        from feishu_wiki.core import _doc_cache_path
        path = _doc_cache_path(title)
        if not path.exists():
            continue
        content = path.read_text(encoding="utf-8")
        if not content:
            continue

        lines = content.split("\n")
        hits = []
        for i, line in enumerate(lines, 1):
            if compiled.search(line):
                hits.append({"line": i, "text": line.strip()[:120]})
        if hits:
            results.append({
                "title": title,
                "category": page.get("category", ""),
                "matches": hits,
            })
    results.sort(key=lambda x: -len(x["matches"]))
    return results


def search_feishu(keyword: str, limit: int = 10, wiki_only: bool = False) -> list:
    """通过飞书搜索 API 全文检索文档。

    返回飞书搜索结果，不缓存非 wiki 页面。
    如果是 AI Wiki 内的页面，可通过 fw.fetch() 按需缓存。

    返回格式: [{"title": str, "summary": str, "url": str, "type": str,
                "owner": str, "updated": str, "token": str, "is_wiki": bool}]
    """
    r = _run_lark(
        ["docs", "+search", "--as", "user", "--query", keyword,
         "--page-size", str(min(limit, 20))]
    )
    if not _is_success(r):
        return []

    # 获取当前 wiki 的 obj_tokens 用于判断是否属于本 wiki
    index = _load_index()
    wiki_tokens = set()
    for title, info in index.get("pages", {}).items():
        if info.get("obj_token"):
            wiki_tokens.add(info["obj_token"])

    results = []
    for item in r.get("data", {}).get("results", []):
        entity_type = item.get("entity_type", "")
        if wiki_only and entity_type != "WIKI":
            continue
        meta = item.get("result_meta", {})
        token = meta.get("token", "")
        title = re.sub(r"</?h>", "", item.get("title_highlighted", ""))
        summary = re.sub(r"</?h>", "", item.get("summary_highlighted", ""))

        is_wiki = token in wiki_tokens

        results.append({
            "title": title,
            "summary": summary,
            "url": meta.get("url", ""),
            "type": entity_type,
            "owner": meta.get("owner_name", ""),
            "updated": meta.get("update_time_iso", "")[:10],
            "token": token,
            "is_wiki": is_wiki,
        })
    return results
