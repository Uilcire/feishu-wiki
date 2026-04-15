# AI Wiki

一个由 AI Agent 维护的共享知识库，专注于 AI 智能体技术（架构、框架、论文、工具、生态）。

灵感来自 [Karpathy 的 LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)：不是 RAG 那种每次查询重新拼凑，而是 AI 把知识**编译一次、持续更新**，构建一个不断变丰富的知识网络。

## 安装

包发布在 GitHub Packages，需要先配置 npm registry：

```bash
# 配置 @uilcire scope 指向 GitHub Packages（一次性）
echo "@uilcire:registry=https://npm.pkg.github.com" >> ~/.npmrc

# 安装
npm install -g @uilcire/ai-wiki
```

> **注意：** 公共 npm 上的 `ai-wiki` 是另一个无关的包，请确保安装的是 `@uilcire/ai-wiki`。

### 前置条件

- Node.js 16+
- [lark-cli](https://www.npmjs.com/package/@larksuite/cli)：`npm install -g @larksuite/cli`
- 飞书账号：`lark-cli auth login`

或运行 `ai-wiki setup` 自动检测并安装依赖。

## 使用

安装好之后，打开你的 Agent（Claude Code / Codex），直接说：

```
"帮我看看 AI Wiki 有什么内容"
"收录这篇论文：https://arxiv.org/abs/..."
"RAG 和知识编译有什么区别？"
"给我看一下 Claude Code 的页面链接"
```

Agent 会自动调用 `ai-wiki` CLI 来操作。你不需要写代码。

## CLI 参考

```bash
# 读操作
ai-wiki find "RAG"                     # 模糊搜索页面
ai-wiki list [--category 主题]          # 列出页面
ai-wiki fetch "页面标题" [--fresh]       # 读取页面正文
ai-wiki link "页面标题"                  # 获取飞书 URL
ai-wiki grep "关键词"                   # 本地全文搜索
ai-wiki search "关键词" [--all-docs]    # 飞书 API 搜索

# 写操作（需先 ai-wiki mode write）
ai-wiki create --category 主题 --title "标题" <<< "内容"
ai-wiki update "标题" [--mode overwrite] <<< "内容"
ai-wiki delete "标题" [--reason "原因"]

# 管理
ai-wiki status          # 缓存状态
ai-wiki mode [read|write]  # 切换模式
ai-wiki setup           # 一键安装配置
ai-wiki lint            # 健康检查
ai-wiki refresh         # 重建索引
```

## 架构

```
用户 → Agent → ai-wiki CLI
                 │
                 ├── find / list / fetch    读（后台索引 + 按需缓存）
                 ├── search                 飞书 API 搜索（索引构建中也可用）
                 ├── create / update        写（自动加锁，多人互斥）
                 └── link                   飞书 URL
                 │
飞书知识库 → 存储后端 + 浏览界面
```

首次运行时索引在后台构建，不阻塞用户。`search` 通过云端 token 清单立即可用。

## 跨 Agent 使用

`npm install` 时自动注册 skill 到：

| Agent | 路径 |
|-------|------|
| Claude Code | `~/.claude/skills/ai-wiki/` |
| Codex | `~/.codex/skills/ai-wiki/` |
| 通用 | `~/.agents/skills/ai-wiki/` |

## 重要规则

- 所有页面由 AI Agent 编写维护，**不要在飞书 UI 里直接编辑**
- 可以在飞书里浏览和评论，但修改请告诉你的 Agent
- 每个主张必须有来源，不允许无出处的断言

详细操作手册见 [SKILL.md](SKILL.md)。

## License

MIT
