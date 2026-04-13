"""
首次使用须知 —— pip install 后首次 import 时强制阅读并确认。
"""

import shutil
import subprocess
import sys
from pathlib import Path

_ACCEPT_FILE = Path.home() / ".feishu-wiki-accepted"
_CONFIG_FILE = Path.home() / ".feishu-wiki-config.json"

_NOTICE = """
═══════════════════════════════════════════════════════════════
  AI Wiki — 欢迎
═══════════════════════════════════════════════════════════════

  这是什么？
  ──────────
  一个由 AI Agent 维护的共享知识库，专注于 AI 智能体技术
  （架构、框架、论文、工具、生态）。

  灵感来自 Karpathy 的 LLM Wiki 模式：不是 RAG 那种
  "每次查询重新拼凑"，而是 AI 把知识编译一次、持续更新，
  构建一个不断变丰富的知识网络。

  你能用它做什么？
  ────────────────
  - 收录：给 Agent 一篇论文/文章/链接，它会深度阅读、
    提取知识、写入维基、建立交叉引用
  - 查询：问 Agent 任何智能体相关的问题，它会从维基中
    检索并综合回答
  - 浏览：让 Agent 给你飞书链接，在浏览器里看排版好的页面
  - 审查：让 Agent 跑一轮健康检查，找矛盾、断链、孤立页面

  怎么用？
  ────────
  安装好之后，打开你的 Agent（Claude Code / Codex），直接说：
    "帮我看看 AI Wiki 有什么内容"
    "收录这篇论文：<URL>"
    "RAG 和知识编译有什么区别？"
  Agent 会自动调用 feishu_wiki 来操作。

  重要规则
  ────────
  - 所有页面由 AI Agent 编写维护，不要在飞书 UI 里直接编辑
  - 可以在飞书里浏览和评论，但修改请告诉你的 Agent
  - 每个主张必须有来源，不允许无出处的断言

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


def _build_skill_content() -> str:
    """构建 SKILL.md 内容（Claude Code + Codex 通用格式）。"""
    agents_content = _get_agents_md_content()
    return (
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


def _setup_agent_instructions():
    """自动将 AI Wiki 注册到所有检测到的 Agent 环境。"""
    marker = Path.home() / ".feishu-wiki-agent-configured"
    if marker.exists():
        return

    skill_content = _build_skill_content()
    registered = []

    # Claude Code: ~/.claude/skills/feishu-wiki/SKILL.md
    claude_dir = Path.home() / ".claude"
    if claude_dir.exists() or shutil.which("claude"):
        skill_dir = claude_dir / "skills" / "feishu-wiki"
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(skill_content, encoding="utf-8")
        registered.append(f"Claude Code ({skill_dir / 'SKILL.md'})")

    # Codex: ~/.codex/skills/feishu-wiki/SKILL.md
    codex_dir = Path.home() / ".codex"
    if codex_dir.exists() or shutil.which("codex"):
        skill_dir = codex_dir / "skills" / "feishu-wiki"
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(skill_content, encoding="utf-8")
        registered.append(f"Codex ({skill_dir / 'SKILL.md'})")

    if registered:
        for r in registered:
            print(f"[fw] 已注册 skill: {r}", file=sys.stderr, flush=True)
    else:
        print(
            "[fw] 未检测到 Claude Code 或 Codex 环境，跳过 skill 注册。\n"
            "     可手动将 AGENTS.md 复制到你的 Agent 指令文件中。",
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

    # 选择使用模式
    _choose_mode()

    print("\n  ✅ 已确认。欢迎使用 AI Wiki！\n")


def _choose_mode():
    """让用户选择默认模式：只读（学习）还是读写（贡献）。"""
    import json

    if _CONFIG_FILE.exists():
        return  # 已选过

    print("""
  选择你的默认模式：
  ──────────────────
  1. 学习模式（只读）
     → 查询知识、浏览页面、搜索内容
     → 不会创建或修改维基页面

  2. 贡献模式（读写）
     → 学习模式的全部功能
     → 可以收录来源、创建页面、更新内容
""")

    try:
        choice = input("  输入 1 或 2（默认 1）: ").strip()
    except (EOFError, KeyboardInterrupt):
        choice = "1"

    write_enabled = choice == "2"
    config = {"write_enabled": write_enabled}
    _CONFIG_FILE.write_text(json.dumps(config, indent=2), encoding="utf-8")

    if write_enabled:
        print("  → 已设为贡献模式（读写）")
    else:
        print("  → 已设为学习模式（只读）")
        print("     随时可用 feishu-wiki mode write 切换到贡献模式")


def get_mode() -> dict:
    """读取用户配置。返回 {"write_enabled": bool}。"""
    import json
    if _CONFIG_FILE.exists():
        try:
            return json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"write_enabled": False}


def is_write_enabled() -> bool:
    """当前用户是否启用了写权限。"""
    return get_mode().get("write_enabled", False)
