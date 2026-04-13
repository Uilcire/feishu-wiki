"""
feishu-wiki CLI —— 一键安装和配置
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def _print_step(num, total, msg):
    print(f"\n  [{num}/{total}] {msg}")


def _check_npm():
    """检查 npm 是否可用。"""
    if shutil.which("npm"):
        return True
    # 尝试 brew 安装的 node
    if shutil.which("brew"):
        result = subprocess.run(
            ["brew", "--prefix", "node"], capture_output=True, text=True
        )
        if result.returncode == 0:
            npm_path = Path(result.stdout.strip()) / "bin" / "npm"
            if npm_path.exists():
                os.environ["PATH"] = str(npm_path.parent) + ":" + os.environ.get("PATH", "")
                return True
    return False


def _install_lark_cli():
    """检查并安装 lark-cli。"""
    if shutil.which("lark-cli"):
        print("  ✅ lark-cli 已安装")
        return True

    print("  ❌ 未检测到 lark-cli，正在安装...")

    if not _check_npm():
        print(
            "  ❌ 未检测到 npm。请先安装 Node.js：\n"
            "     macOS:   brew install node\n"
            "     其他：   https://nodejs.org/\n"
            "  然后重新运行 feishu-wiki setup"
        )
        return False

    result = subprocess.run(
        ["npm", "install", "-g", "@anthropic-ai/lark-cli"],
        capture_output=False,
    )
    if result.returncode != 0:
        print("  ❌ lark-cli 安装失败，请手动安装：")
        print("     npm install -g @anthropic-ai/lark-cli")
        return False

    print("  ✅ lark-cli 已安装")
    return True


def _ensure_auth():
    """检查 lark-cli 登录状态，未登录则引导登录。"""
    try:
        result = subprocess.run(
            ["lark-cli", "auth", "status"],
            capture_output=True, text=True,
        )
        data = json.loads(result.stdout)
        name = data.get("userName")
        if name:
            print(f"  ✅ 已登录：{name}")
            return True
    except Exception:
        pass

    print("  未登录，正在启动飞书授权...")
    result = subprocess.run(
        ["lark-cli", "auth", "login"],
        capture_output=False,
    )
    if result.returncode != 0:
        print("  ❌ 登录失败，请手动执行：lark-cli auth login")
        return False

    print("  ✅ 登录成功")
    return True


def _get_agents_md_content():
    """获取 AGENTS.md 的内容（从包内读取）。"""
    # 尝试从包目录的上级找 AGENTS.md
    pkg_dir = Path(__file__).parent
    agents_md = pkg_dir.parent / "AGENTS.md"
    if agents_md.exists():
        return agents_md.read_text(encoding="utf-8")

    # fallback：从安装的包数据中读取
    try:
        import importlib.resources as pkg_resources
        return pkg_resources.read_text("feishu_wiki", "AGENTS.md")
    except Exception:
        pass

    # 最后 fallback：返回简短指引
    return (
        "# AI Wiki\n\n"
        "使用 `import feishu_wiki as fw` 操作 AI Wiki 知识库。\n"
        "完整文档：https://github.com/Uilcire/feishu-wiki/blob/main/AGENTS.md\n"
    )


def _setup_agent():
    """检测 Agent 环境并注册 SKILL.md。"""
    from feishu_wiki.onboarding import _build_skill_content
    skill_content = _build_skill_content()
    registered = []

    # Claude Code: ~/.claude/skills/feishu-wiki/SKILL.md
    claude_dir = Path.home() / ".claude"
    if claude_dir.exists() or shutil.which("claude"):
        skill_dir = claude_dir / "skills" / "feishu-wiki"
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(skill_content, encoding="utf-8")
        print(f"  ✅ Claude Code：已注册 skill → {skill_dir / 'SKILL.md'}")
        registered.append("claude")

    # Codex: ~/.codex/skills/feishu-wiki/SKILL.md
    codex_dir = Path.home() / ".codex"
    if codex_dir.exists() or shutil.which("codex"):
        skill_dir = codex_dir / "skills" / "feishu-wiki"
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(skill_content, encoding="utf-8")
        print(f"  ✅ Codex：已注册 skill → {skill_dir / 'SKILL.md'}")
        registered.append("codex")

    if not registered:
        # 未检测到特定 agent，创建 AGENTS.md
        agents_md = Path.cwd() / "AGENTS.md"
        if not agents_md.exists():
            agents_md.write_text(_get_agents_md_content(), encoding="utf-8")
            print(f"  ✅ 已创建 {agents_md}（通用 Agent 指令文件）")
        else:
            print(f"  ⚠️ {agents_md} 已存在，跳过写入")
        registered.append("generic")

    return registered[0] if registered else "generic"


def _show_onboarding():
    """显示项目须知并确认。"""
    accept_file = Path.home() / ".feishu-wiki-accepted"
    if accept_file.exists():
        print("  ✅ 项目须知已确认")
        return True

    from feishu_wiki.onboarding import _NOTICE
    print(_NOTICE)
    try:
        response = input("  输入 'yes' 确认你已阅读并同意以上须知: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print("\n  未确认，退出。")
        return False

    if response != "yes":
        print("  未确认，退出。")
        return False

    accept_file.touch()
    print("  ✅ 已确认")
    return True


def _verify():
    """验证安装是否成功。"""
    try:
        import feishu_wiki as fw
        status = fw.status()
        pages = status.get("pages", 0)
        print(f"  ✅ 连接成功！AI Wiki 共 {pages} 个页面")
        return True
    except Exception as e:
        print(f"  ❌ 验证失败: {e}")
        return False


def main():
    args = sys.argv[1:]

    if not args or args[0] == "setup":
        print("═" * 55)
        print("  feishu-wiki setup")
        print("═" * 55)

        total = 5

        _print_step(1, total, "检查 lark-cli...")
        if not _install_lark_cli():
            sys.exit(1)

        _print_step(2, total, "检查飞书登录...")
        if not _ensure_auth():
            sys.exit(1)

        _print_step(3, total, "配置 Agent 环境...")
        agent = _setup_agent()

        _print_step(4, total, "项目须知...")
        if not _show_onboarding():
            sys.exit(1)

        _print_step(5, total, "验证连接...")
        _verify()

        print("\n" + "═" * 55)
        print("  ✅ 设置完成！")
        print()
        if agent == "claude":
            print("  告诉你的 Agent：")
            print('    "帮我查一下 AI Wiki 有什么内容"')
            print()
            print("  或使用 /wiki 命令加载完整指令")
        else:
            print("  告诉你的 Agent：")
            print('    "帮我查一下 AI Wiki 有什么内容"')
        print("═" * 55)

    elif args[0] == "status":
        import feishu_wiki as fw
        status = fw.status()
        print(json.dumps(status, ensure_ascii=False, indent=2))

    elif args[0] == "help":
        print("用法: feishu-wiki <command>")
        print()
        print("命令:")
        print("  setup    一键安装和配置（首次使用）")
        print("  status   查看 wiki 状态")
        print("  help     显示帮助")

    else:
        print(f"未知命令: {args[0]}")
        print("运行 feishu-wiki help 查看可用命令")
        sys.exit(1)


if __name__ == "__main__":
    main()
