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
            _ensure_scopes()
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
    _ensure_scopes()
    return True


def _ensure_scopes():
    """确保反馈功能所需的 scope 已授权。"""
    needed = ["base:app:create"]
    try:
        result = subprocess.run(
            ["lark-cli", "auth", "status"],
            capture_output=True, text=True,
        )
        data = json.loads(result.stdout)
        granted = data.get("scopes") or []
        missing = [s for s in needed if s not in granted]
        if not missing:
            return
        print(f"  正在申请额外权限（用于反馈功能）...")
        for scope in missing:
            subprocess.run(
                ["lark-cli", "auth", "login", "--scope", scope],
                capture_output=False,
            )
    except Exception:
        pass


def _get_skill_content():
    """获取 SKILL.md 的内容（从包内读取）。"""
    pkg_dir = Path(__file__).parent
    skill_md = pkg_dir.parent / "SKILL.md"
    if skill_md.exists():
        return skill_md.read_text(encoding="utf-8")

    # fallback：从安装的包数据中读取
    try:
        import importlib.resources as pkg_resources
        return pkg_resources.read_text("feishu_wiki", "SKILL.md")
    except Exception:
        pass

    return (
        "# AI Wiki\n\n"
        "使用 `import feishu_wiki as fw` 操作 AI Wiki 知识库。\n"
        "完整文档：https://github.com/Uilcire/feishu-wiki\n"
    )


def _setup_agent():
    """检测 Agent 环境并注册完整 skill 文件夹。"""
    pkg_dir = Path(__file__).parent  # feishu_wiki/ 包目录
    registered = []

    def _copy_skill_to(skill_dir: Path):
        """将包内 skill 数据复制到目标目录。"""
        skill_dir.mkdir(parents=True, exist_ok=True)
        # SKILL.md
        src = pkg_dir / "SKILL.md"
        if src.exists():
            shutil.copy2(src, skill_dir / "SKILL.md")
        # 子目录：templates/, references/, agents/
        for subdir in ("templates", "references", "agents"):
            src_dir = pkg_dir / subdir
            dst_dir = skill_dir / subdir
            if src_dir.is_dir():
                if dst_dir.exists():
                    shutil.rmtree(dst_dir)
                shutil.copytree(src_dir, dst_dir)

    # Claude Code: ~/.claude/skills/feishu-wiki/
    claude_dir = Path.home() / ".claude"
    if claude_dir.exists() or shutil.which("claude"):
        skill_dir = claude_dir / "skills" / "feishu-wiki"
        _copy_skill_to(skill_dir)
        print(f"  ✅ Claude Code：已注册 skill → {skill_dir}")
        registered.append("claude")

    # Codex: ~/.codex/skills/feishu-wiki/
    codex_dir = Path.home() / ".codex"
    if codex_dir.exists() or shutil.which("codex"):
        skill_dir = codex_dir / "skills" / "feishu-wiki"
        _copy_skill_to(skill_dir)
        print(f"  ✅ Codex：已注册 skill → {skill_dir}")
        registered.append("codex")

    if not registered:
        # 未检测到特定 agent，复制到当前目录
        skill_dir = Path.cwd() / "feishu-wiki-skill"
        _copy_skill_to(skill_dir)
        print(f"  ✅ 已创建 {skill_dir}（通用 skill 文件夹）")
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

    elif args[0] == "find":
        if len(args) < 2:
            print("用法: feishu-wiki find <query> [--category CAT]")
            sys.exit(1)
        category = None
        query_parts = []
        i = 1
        while i < len(args):
            if args[i] == "--category" and i + 1 < len(args):
                category = args[i + 1]
                i += 2
            else:
                query_parts.append(args[i])
                i += 1
        query = " ".join(query_parts)
        from feishu_wiki.core import find
        result = find(query, category=category)
        if result:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(json.dumps(None))
            sys.exit(1)

    elif args[0] == "list":
        category = None
        if len(args) >= 3 and args[1] == "--category":
            category = args[2]
        from feishu_wiki.core import list_pages
        pages = list_pages(category=category)
        print(json.dumps(pages, ensure_ascii=False, indent=2))

    elif args[0] == "fetch":
        if len(args) < 2:
            print("用法: feishu-wiki fetch <title> [--fresh]")
            sys.exit(1)
        fresh = "--fresh" in args
        title = " ".join(a for a in args[1:] if a != "--fresh")
        from feishu_wiki.core import fetch, find
        page = find(title)
        if not page:
            print(f"未找到页面: {title}", file=sys.stderr)
            sys.exit(1)
        content = fetch(page, fresh=fresh)
        print(content)

    elif args[0] == "link":
        if len(args) < 2:
            print("用法: feishu-wiki link <title>")
            sys.exit(1)
        title = " ".join(args[1:])
        from feishu_wiki.core import link
        try:
            url = link(title)
            print(url)
        except Exception as e:
            print(f"错误: {e}", file=sys.stderr)
            sys.exit(1)

    elif args[0] == "grep":
        if len(args) < 2:
            print("用法: feishu-wiki grep <pattern> [--category CAT]")
            sys.exit(1)
        category = None
        pattern_parts = []
        i = 1
        while i < len(args):
            if args[i] == "--category" and i + 1 < len(args):
                category = args[i + 1]
                i += 2
            else:
                pattern_parts.append(args[i])
                i += 1
        pattern = " ".join(pattern_parts)
        from feishu_wiki.search import grep
        results = grep(pattern, category=category)
        print(json.dumps(results, ensure_ascii=False, indent=2))

    elif args[0] == "search":
        if len(args) < 2:
            print("用法: feishu-wiki search <query> [--wiki-only]")
            sys.exit(1)
        wiki_only = "--wiki-only" in args
        query = " ".join(a for a in args[1:] if a != "--wiki-only")
        from feishu_wiki.search import search_feishu
        results = search_feishu(query, wiki_only=wiki_only)
        print(json.dumps(results, ensure_ascii=False, indent=2))

    elif args[0] == "create":
        category = title = summary = None
        i = 1
        while i < len(args):
            if args[i] == "--category" and i + 1 < len(args):
                category = args[i + 1]; i += 2
            elif args[i] == "--title" and i + 1 < len(args):
                title = args[i + 1]; i += 2
            elif args[i] == "--summary" and i + 1 < len(args):
                summary = args[i + 1]; i += 2
            else:
                i += 1
        if not category or not title:
            print("用法: feishu-wiki create --category CAT --title TITLE [--summary S] <<< content")
            sys.exit(1)
        content = sys.stdin.read()
        if not content.strip():
            print("错误: 内容为空（通过 stdin 传入）", file=sys.stderr)
            sys.exit(1)
        from feishu_wiki.core import create
        result = create(category, title, content, summary=summary or "")
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif args[0] == "write":
        if len(args) < 2:
            print("用法: feishu-wiki write <title> [--mode append|overwrite] <<< content")
            sys.exit(1)
        mode = "append"
        title_parts = []
        i = 1
        while i < len(args):
            if args[i] == "--mode" and i + 1 < len(args):
                mode = args[i + 1]; i += 2
            else:
                title_parts.append(args[i]); i += 1
        title = " ".join(title_parts)
        content = sys.stdin.read()
        if not content.strip():
            print("错误: 内容为空（通过 stdin 传入）", file=sys.stderr)
            sys.exit(1)
        from feishu_wiki.core import update
        update(title, content, mode=mode)
        print(json.dumps({"ok": True, "title": title, "mode": mode}, ensure_ascii=False))

    elif args[0] == "sync":
        from feishu_wiki.core import sync
        result = sync()
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif args[0] == "refresh":
        from feishu_wiki.core import refresh
        refresh()
        print(json.dumps({"ok": True}))

    elif args[0] == "compact-log":
        days = 7
        if len(args) >= 3 and args[1] == "--days":
            days = int(args[2])
        from feishu_wiki.core import compact_log
        compact_log(days=days)
        print(json.dumps({"ok": True, "days_kept": days}))

    elif args[0] == "lint":
        from feishu_wiki.core import lint
        result = lint()
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif args[0] == "user":
        from feishu_wiki.core import current_user
        print(json.dumps(current_user(), ensure_ascii=False, indent=2))

    elif args[0] == "status":
        import feishu_wiki as fw
        status = fw.status()
        print(json.dumps(status, ensure_ascii=False, indent=2))

    elif args[0] == "mode":
        from feishu_wiki.onboarding import _CONFIG_FILE, get_mode
        if len(args) < 2:
            mode = get_mode()
            current = "贡献模式（读写）" if mode.get("write_enabled") else "学习模式（只读）"
            print(f"  当前模式：{current}")
            print()
            print("  切换：feishu-wiki mode read   → 学习模式")
            print("        feishu-wiki mode write  → 贡献模式")
        elif args[1] in ("write", "贡献"):
            _CONFIG_FILE.write_text(json.dumps({"write_enabled": True}, indent=2))
            print("  ✅ 已切换到贡献模式（读写）")
        elif args[1] in ("read", "学习"):
            _CONFIG_FILE.write_text(json.dumps({"write_enabled": False}, indent=2))
            print("  ✅ 已切换到学习模式（只读）")
        else:
            print(f"  未知模式: {args[1]}，可选: read / write")

    elif args[0] == "feedback":
        if len(args) < 2:
            print("用法: feishu-wiki feedback \"你的反馈内容\"")
            sys.exit(1)
        content = " ".join(args[1:])
        from feishu_wiki.core import feedback
        result = feedback(content)
        if result.get("ok"):
            print(f"  ✅ 反馈已提交！")
        else:
            print(f"  ❌ 提交失败: {result.get('error')}")

    elif args[0] == "update":
        from feishu_wiki._version_check import check_update, _get_local_version
        print("  正在检查更新...")
        info = check_update()
        if not info:
            print(f"  ✅ 已是最新版本（{_get_local_version()}）")
        else:
            print(f"  发现新版本 {info['latest']}（当前 {info['local']}），正在升级...")
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--upgrade", "feishu-wiki"],
                capture_output=False,
            )
            if result.returncode == 0:
                print(f"\n  ✅ 已升级到 {info['latest']}")
            else:
                print("\n  ❌ 升级失败，请手动运行：")
                print("     python3 -m pip install --upgrade feishu-wiki")

    elif args[0] == "delete":
        if len(args) < 2:
            print("用法: feishu-wiki delete <title> [--reason REASON]")
            sys.exit(1)
        reason = ""
        title_parts = []
        i = 1
        while i < len(args):
            if args[i] == "--reason" and i + 1 < len(args):
                reason = args[i + 1]; i += 2
            else:
                title_parts.append(args[i]); i += 1
        title = " ".join(title_parts)
        from feishu_wiki.core import delete
        delete(title, reason=reason)
        print(json.dumps({"ok": True, "title": title, "action": "deprecated"}, ensure_ascii=False))

    elif args[0] == "help":
        print("用法: feishu-wiki <command>")
        print()
        print("读操作:")
        print("  find <query>              模糊搜索页面")
        print("  list [--category CAT]     列出页面")
        print("  fetch <title> [--fresh]   读取页面正文（markdown）")
        print("  link <title>              获取飞书 URL")
        print("  grep <pattern>            本地全文搜索")
        print("  search <query>            飞书 API 搜索")
        print()
        print("写操作:")
        print("  create --category CAT --title TITLE [--summary S] <<< content")
        print("  write <title> [--mode append|overwrite] <<< content")
        print("  delete <title> [--reason R]  软删除（标记已废弃）")
        print()
        print("管理:")
        print("  status     缓存状态")
        print("  user       当前用户")
        print("  sync       手动同步")
        print("  refresh    重建索引")
        print("  mode       查看/切换模式（read / write）")
        print("  feedback   提交反馈")
        print("  setup      一键安装和配置")
        print("  update     检查并升级版本")
        print("  help       显示帮助")

    else:
        print(f"未知命令: {args[0]}")
        print("运行 feishu-wiki help 查看可用命令")
        sys.exit(1)


if __name__ == "__main__":
    main()
