# feishu-wiki

AI Agent 协作维基 —— 基于飞书知识库的共享知识管理工具。

## 这是什么

一个由 AI Agent 维护的共享知识库，专注于 AI 智能体技术。人类负责整理来源、提问和引导方向，AI Agent 负责所有读写操作。

核心理念来自 [Karpathy 的 LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)：LLM 增量构建并维护一个持久化的知识库，知识被编译一次、持续更新，而不是每次查询时重新推导。

## 安装

### 前置条件

1. Python 3.9+
2. [lark-cli](https://github.com/nicefan/lark-cli) 已安装并登录

### 安装

```bash
pip install feishu-wiki
```

### 首次使用

```bash
# 确保 lark-cli 已登录
lark-cli auth login

# 在你的项目目录中
python3 -c "import feishu_wiki as fw; fw.status()"
```

首次 import 会显示项目须知，输入 `yes` 确认后即可使用。

### 配置 Agent

将 `AGENTS.md` 的内容复制到你的 Agent 指令文件中：

| Agent | 指令文件 |
|---|---|
| Claude Code | `CLAUDE.md` |
| OpenAI Codex | `AGENTS.md` |
| Cursor | `.cursorrules` |
| 其他 | 参考各 Agent 文档 |

## 快速开始

```python
import feishu_wiki as fw

# 查看维基状态
fw.status()

# 列出所有页面
for p in fw.list_pages():
    print(f"{p['category']:12s} | {p['title']}")
    if p.get('summary'):
        print(f"{'':12s}   {p['summary']}")

# 读取页面
content = fw.fetch("智能体护栏与约束")

# 获取页面链接（给用户在浏览器中查看）
url = fw.link("智能体护栏与约束")

# 搜索
fw.grep("ReAct")                          # 本地全文搜索
fw.search_feishu("智能体", wiki_only=True)  # 飞书 API 搜索

# 写入（自动加锁）
fw.update("页面标题", "追加内容")

# 批量写入
with fw.lock():
    fw.create("来源", "新来源", "内容", summary="一句话摘要")
    fw.update("相关主题", "补充段落")
```

## 架构

```
你（用户）→ 告诉 Agent 你想做什么
Agent     → 通过 feishu_wiki API 读写飞书知识库
飞书      → 知识库的存储后端 + 浏览界面
```

**重要规则**：
- ❌ 不要在飞书 UI 中直接编辑维基页面
- ❌ 不要绕过 Agent 手动修改内容
- ✅ 可以在飞书中浏览页面和添加评论
- ✅ 所有修改都让你的 Agent 代劳

详细操作手册见 [AGENTS.md](AGENTS.md)。

## License

MIT
