"""
首次使用须知 —— pip install 后首次 import 时强制阅读并确认。
"""

import shutil
import subprocess
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


def _check_lark_cli():
    """检查 lark-cli 是否已安装并登录。"""
    if not shutil.which("lark-cli"):
        print(
            "\n  ❌ 未检测到 lark-cli。请先安装：\n"
            "     npm install -g @anthropic-ai/lark-cli\n"
            "\n  安装后登录飞书：\n"
            "     lark-cli auth login\n",
            file=sys.stderr,
        )
        sys.exit(1)

    # 检查是否已登录
    try:
        result = subprocess.run(
            ["lark-cli", "auth", "status"],
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0 or "userName" not in result.stdout:
            print(
                "\n  ❌ lark-cli 未登录。请先执行：\n"
                "     lark-cli auth login\n",
                file=sys.stderr,
            )
            sys.exit(1)
    except Exception:
        print(
            "\n  ❌ 无法检查 lark-cli 登录状态。请确认 lark-cli 正常工作。\n",
            file=sys.stderr,
        )
        sys.exit(1)


def _get_agents_md_content() -> str:
    """读取 AGENTS.md 内容。"""
    agents_md = Path(__file__).parent.parent / "AGENTS.md"
    if agents_md.exists():
        return agents_md.read_text(encoding="utf-8")
    return (
        "# AI Wiki\n\n"
        "使用 `import feishu_wiki as fw` 操作 AI Wiki 知识库。\n"
        "完整文档：https://github.com/Uilcire/feishu-wiki/blob/main/AGENTS.md\n"
    )


def _setup_agent_instructions():
    """自动将 AI Wiki 注册为 Claude Code skill（首次 import 时执行一次）。"""
    marker = Path.home() / ".feishu-wiki-agent-configured"
    if marker.exists():
        return

    claude_dir = Path.home() / ".claude"
    if not (claude_dir.exists() or shutil.which("claude")):
        marker.touch()
        return

    # 写入 ~/.claude/skills/feishu-wiki/SKILL.md
    skill_dir = claude_dir / "skills" / "feishu-wiki"
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_md = skill_dir / "SKILL.md"

    agents_content = _get_agents_md_content()

    skill_content = (
        '---\n'
        'name: feishu-wiki\n'
        'version: 0.1.0\n'
        'description: "AI Wiki 协作知识库：收录来源、查询知识、维护交叉引用。'
        '当用户提到 AI Wiki、知识库、收录文章/论文、查询智能体相关知识时使用。"\n'
        'metadata:\n'
        '  requires:\n'
        '    bins: ["lark-cli", "python3"]\n'
        '---\n\n'
        + agents_content
    )

    skill_md.write_text(skill_content, encoding="utf-8")
    print(
        f"[fw] 已注册 Claude Code skill: {skill_md}",
        file=sys.stderr, flush=True,
    )

    marker.touch()


def ensure_accepted():
    """检查依赖环境、配置 Agent、确认项目须知。"""
    _check_lark_cli()
    _setup_agent_instructions()

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
