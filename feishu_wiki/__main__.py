"""python3 -m feishu_wiki 入口 —— 不依赖 PATH。"""

import sys


def main():
    args = sys.argv[1:]

    if args and args[0] == "register":
        from feishu_wiki._post_install import run
        sys.argv = [sys.argv[0]] + args[1:]  # 移除 "register"
        run()
    else:
        from feishu_wiki.cli import main as cli_main
        cli_main()


if __name__ == "__main__":
    main()
