"""
feishu-wiki —— AI Agent 协作维基工具包

基于飞书知识库的共享知识管理系统。所有维基页面由 AI Agent 维护，
人类负责来源整理、提问和方向引导。

安装后首次 import 会显示项目须知，需确认后方可使用。

用法：
    import feishu_wiki as fw

    fw.list_pages()                         # 列出所有页面
    fw.find("RAG")                          # 按标题查找
    fw.fetch("检索增强生成（RAG）")            # 读取页面正文
    fw.link("检索增强生成（RAG）")             # 获取飞书链接
    fw.grep("关键词")                        # 本地全文搜索
    fw.search_feishu("关键词")               # 飞书 API 全文搜索

    fw.feedback("希望支持批量导入")           # 提交反馈到飞书
    fw.log_qa("用户问题", "agent 回答")      # 记录 QA 交互

    with fw.lock():                         # 批量写操作
        fw.create("主题", "新页面", "内容")
        fw.update("现有页面", "追加内容")
"""

from feishu_wiki.core import (
    init,
    find,
    list_pages,
    exists,
    fetch,
    create,
    update,
    delete,
    append_log,
    compact_log,
    lint,
    link,
    status,
    sync,
    refresh,
    current_user,
    resolve_wikilinks,
    feedback,
    log_qa,
)
from feishu_wiki.lock import lock
from feishu_wiki.search import grep, search_feishu
from feishu_wiki.onboarding import ensure_accepted

# 首次 import 时检查须知确认
ensure_accepted()

__version__ = "0.2.7"
__all__ = [
    "init", "find", "list_pages", "exists", "fetch",
    "create", "update", "delete", "append_log", "compact_log", "lint", "link",
    "status", "sync", "refresh", "current_user",
    "resolve_wikilinks", "feedback", "log_qa", "lock", "grep", "search_feishu",
]
