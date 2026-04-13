"""
首次使用须知 —— pip install 后首次 import 时强制阅读并确认。
"""

import sys
from pathlib import Path

_ACCEPT_FILE = Path.home() / ".feishu-wiki-accepted"

_NOTICE = """
═══════════════════════════════════════════════════════════════
  AI Wiki — 项目须知（首次使用必读）
═══════════════════════════════════════════════════════════════

  欢迎加入 AI Wiki 协作知识库！

  这是一个由 AI Agent 维护的共享知识库，专注于 AI 智能体技术。
  在使用之前，请务必了解以下规则：

  1. 所有页面内容由 AI Agent 负责编写和维护
     ❌ 禁止在飞书 UI 中直接编辑维基页面正文
     ❌ 禁止在飞书 UI 中添加图片/表格/视频
     ❌ 禁止在飞书 UI 中移动或重命名节点
     ✅ 可以在飞书中浏览页面
     ✅ 可以在飞书中添加评论

  2. 所有修改必须通过你的 AI Agent 执行
     告诉你的 Agent 你想做什么，它会通过 feishu_wiki API 操作

  3. 如需浏览页面，请让你的 Agent 提供链接
     Agent 会调用 fw.link("页面名") 给你飞书 URL

  4. 写操作自动加锁，请勿绕过锁机制
     多人协作时，写入通过 Queue 页面排队，确保互斥

  5. 每个事实主张必须标注来源，不允许无出处的主张

  6. 维基内容使用中文撰写，专有名词保留原文
     格式：中文名（English Name），如 检索增强生成（RAG）

═══════════════════════════════════════════════════════════════
"""


def ensure_accepted():
    """检查用户是否已确认项目须知。未确认则显示须知并要求确认。"""
    if _ACCEPT_FILE.exists():
        return

    # 非交互环境（Agent 调用）：自动接受
    if not sys.stdin.isatty():
        _ACCEPT_FILE.touch()
        return

    print(_NOTICE)
    try:
        response = input("  输入 'yes' 确认你已阅读并同意以上须知: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print("\n未确认须知，退出。")
        sys.exit(1)

    if response != "yes":
        print("未确认须知，退出。")
        sys.exit(1)

    _ACCEPT_FILE.touch()
    print("\n  ✅ 已确认。欢迎使用 AI Wiki！\n")
