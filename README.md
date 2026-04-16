# AI Wiki

一个由 AI Agent 维护的共享知识库，专注于 AI 智能体技术（架构、框架、论文、工具、生态）。

灵感来自 [Karpathy 的 LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)：不是 RAG 那种每次查询重新拼凑，而是 AI 把知识**编译一次、持续更新**，构建一个不断变丰富的知识网络。

本技能的设计灵感亦源自 Andre Carpenter 创作的 Ellen Wiki，可让你的智能助手对复杂信息完成吸收、理解、整理与团队共享，助力团队搭建一个可实时更新、可检索的动态知识库，同时提升个人学习效率与协作效果。

## 核心功能

**内容吸收与梳理**
自动解析链接、PDF、文档或纯文本内容，提取核心观点、梳理关键信息，将复杂内容转化为结构清晰、易于理解的形式。

**关联思路与激发创意**
在理解内容后，协助使用者建立新知识与现有认知的关联，挖掘信息间的联系、推导假设并产出可落地的思路，打通不同主题、不同团队领域的知识壁垒。

**存入团队共享知识库**
内容处理完成后，可将梳理后的知识、原始资料以及思考过程一并存入共享 AI 知识库，形成可持续沉淀的资源库，供全体成员后续查阅、提问与拓展使用。

## 核心使用流程

1. 将链接或 PDF 文件发送给你的智能助手
2. 助手完成内容读取、吸收与梳理
3. 针对内容提问、梳理收获、深入探究细节
4. 选择将本次学习成果存入团队 AI 知识库，方便后续协作与学习

## 适用人群

- 需要处理大量文档资料的团队
- 希望高效学习、快速沉淀并共享知识的成员
- 搭建内部 wiki、研究资料库、产品知识库的团队
- 想要把零散信息转化为可复用团队知识的使用者

## 安装

```bash
npm install -g @uilcire/ai-wiki
ai-wiki setup                      # 自动安装 lark-cli + 登录飞书
```

### Codex 沙箱网络配置

Codex 沙箱默认拦截出站请求，需在 allowedUrls 中添加：

- `https://open.feishu.cn/*`
- `https://open.larksuite.com/*`
- `https://registry.npmjs.org/*`

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
ai-wiki find "RAG"                     # 模糊搜索（返回 match_type/ambiguity_count）
ai-wiki list [--category 主题]          # 列出页面（返回 freshness/data_source）
ai-wiki fetch "标题"                    # 读取页面正文
ai-wiki fetch "标题" --head             # 仅元信息 + 章节列表（JSON）
ai-wiki fetch "标题" --section "核心思想" # 仅返回指定 H2 章节
ai-wiki fetch "标题" --excerpt "关键词"  # 关键词上下文摘录
ai-wiki link "标题"                     # 获取飞书 URL
ai-wiki grep "关键词"                   # 本地全文搜索（返回 coverage_ratio）
ai-wiki search "关键词" [--all-docs]    # 飞书 API 搜索

# 写操作（需先 ai-wiki mode write）
# 内容支持 [[页面名]] wikilinks，写入时自动解析为飞书链接
ai-wiki create --category 主题 --title "标题" <<< "内容"  # 重名自动拒绝
ai-wiki update "标题" [--mode overwrite] <<< "内容"       # 原始资料不可变
ai-wiki delete "标题" [--reason "原因"]

# 管理
ai-wiki status              # 缓存状态
ai-wiki mode [read|write]   # 切换模式
ai-wiki lint                # 全量健康检查
ai-wiki lint --title "标题"  # 单页写入验证
ai-wiki verify-write "标题"  # 单页写入验证
ai-wiki setup               # 一键安装配置
ai-wiki refresh             # 重建索引
ai-wiki upgrade             # 升级到最新版本
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

首次运行时索引同步构建，完成后命令正常返回。`search` 通过云端 token 清单在构建完成前也可用。

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
- `原始资料/*` 页面是不可变归档，不要修改
- 不要删除页面，标记 `[已废弃]` 即可，Agent 会处理真正的删除

详细操作手册见 [SKILL.md](SKILL.md)。

## 故障排除

| 问题 | 解决方法 |
|------|----------|
| `command not found` | `export PATH="$HOME/.npm-global/bin:$PATH"` |
| 提示"新版本可用" | 先运行 `ai-wiki upgrade` 再继续操作 |
| 写锁卡住 | 等 5 分钟自动释放，或执行 `ai-wiki fetch "队列" --fresh` 查看队列 |
| 缓存损坏 | `rm -rf .cache && ai-wiki refresh` |

## License

MIT
