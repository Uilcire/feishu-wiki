"""pip install 后自动调用，注册 skill 并显示提示。"""

import sys


def run():
    from feishu_wiki.onboarding import _setup_agent_instructions
    _setup_agent_instructions()
    print(
        "\n  ✅ feishu-wiki 已安装！\n"
        "     打开你的 Agent（Claude Code / Codex），\n"
        "     说 \"帮我查一下 AI Wiki 有什么内容\" 即可开始。\n"
    )


if __name__ == "__main__":
    run()
