# feishu-wiki

一个由 AI Agent 维护的共享知识库，专注于 AI 智能体技术（架构、框架、论文、工具、生态）。

灵感来自 [Karpathy 的 LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)：不是 RAG 那种每次查询重新拼凑，而是 AI 把知识**编译一次、持续更新**，构建一个不断变丰富的知识网络。

## 你能用它做什么

- **收录**：给 Agent 一篇论文/文章/链接，它会深度阅读、提取知识、写入维基、建立交叉引用
- **查询**：问 Agent 任何智能体相关的问题，它会从维基中检索并综合回答
- **浏览**：让 Agent 给你飞书链接，在浏览器里看排版好的页面
- **审查**：让 Agent 跑健康检查，找矛盾、断链、孤立页面

## 安装

```bash
pip install feishu-wiki
```

首次 `import feishu_wiki` 时会自动检查 lark-cli、注册 Agent skill、显示项目须知。

### 前置条件

- Python 3.9+
- [lark-cli](https://www.npmjs.com/package/@larksuite/cli)：`npm install -g @larksuite/cli`
- 飞书账号：`lark-cli auth login`

## 使用

安装好之后，打开你的 Agent（Claude Code / Codex），直接说：

```
"帮我看看 AI Wiki 有什么内容"
"收录这篇论文：https://arxiv.org/abs/..."
"RAG 和知识编译有什么区别？"
"给我看一下 Claude Code 的页面链接"
```

Agent 会自动调用 `feishu_wiki` 来操作。你不需要写代码。

## 项目结构

本项目遵循 [Agent Skills 标准](https://code.claude.com/docs/en/agent-sdk/skills)：

```
feishu-wiki/
├── SKILL.md              # 核心 Agent 操作手册（YAML frontmatter + 指令）
├── feishu_wiki/           # Python 包（API + CLI）
├── scripts/               # 辅助脚本
├── references/            # 架构文档
├── templates/             # 页面结构模板
├── agents/                # 平台适配（Claude Code / Codex）
├── pyproject.toml
└── README.md
```

### 跨 Agent 使用

复制或符号链接到对应 Agent 的 skills 目录：

| Agent | 安装路径 |
|-------|---------|
| Claude Code | `~/.claude/skills/feishu-wiki/` |
| Codex | `~/.codex/skills/feishu-wiki/` |
| Cursor | `~/.cursor/skills/feishu-wiki/` |

或运行 `feishu-wiki setup` 自动注册。

## 架构

```
你（用户）──→ 告诉 Agent 你想做什么
                │
Agent ─────→ import feishu_wiki as fw
                │
                ├── fw.find() / fw.fetch()     读（按需缓存，ms 级）
                ├── fw.create() / fw.update()  写（自动加锁，多人互斥）
                ├── fw.link()                  给你飞书 URL
                └── fw.grep() / fw.search()    搜索
                │
飞书知识库 ──→ 存储后端 + 浏览界面
```

## QA 追踪

所有查询操作（`find`/`fetch`/`grep`/`search_feishu`）自动记录到飞书 Base，用于评估和产品迭代。

Agent 回答用户问题后会调用 `fw.log_qa()` 记录完整交互：

```python
fw.log_qa(
    "用户的问题",
    "agent 的回答",
    tools=[
        {"name": "find",  "input": "ReAct", "output": "None",       "error": None},
        {"name": "grep",  "input": "ReAct", "output": "3 pages matched", "error": None},
    ]
)
```

每条记录包含：用户问题、工具调用链路（name/input/output/error）、最终回答、是否有错误。

设环境变量 `FEISHU_WIKI_QA_LOG=0` 可关闭追踪。

## 反馈

有需求或改进建议？告诉你的 Agent：

```
"帮我提交一条反馈：希望支持批量导入"
```

或直接调用：`feishu-wiki feedback "你的反馈内容"`

## 更新

```bash
feishu-wiki update
```

## 重要规则

- 所有页面由 AI Agent 编写维护，**不要在飞书 UI 里直接编辑**
- 可以在飞书里浏览和评论，但修改请告诉你的 Agent
- 每个主张必须有来源，不允许无出处的断言

详细操作手册见 [SKILL.md](SKILL.md)。

## License

MIT
