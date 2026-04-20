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
"用 ai-wiki skill，帮我看看 AI Wiki 有什么内容"
"用 ai-wiki skill，收录这篇论文：https://arxiv.org/abs/..."
"用 ai-wiki skill，RAG 和知识编译有什么区别？"
"用 ai-wiki skill，给我看一下 Claude Code 的页面链接"
```

> **提示：** 请求中需要主动提及"ai-wiki skill"，Agent 才会加载知识库操作能力。加载后即可自动调用 `ai-wiki` CLI，你不需要写代码。

## 批量导入（import）

把飞书**个人云空间（Drive）** 里的 docx 批量迁入 **另一个** 知识库——默认是"技术库 / Large Base Engineering"（Base 引擎相关技术内容）。和 AI Wiki **并存但独立**，`find` / `create` / `update` 等命令完全不会碰技术库，反过来 `import` 也只影响技术库。

触发：对 Agent 说 "批量导入 / 批量录入 / 批量收录 / 导入我的文档 / 录入个人空间" 等。

流程（Agent 自动走完前 4 步，`apply --yes` 必须你明确批准）：

```bash
ai-wiki import scan                              # 1. 扫描"我的空间"根（不带参数即可）
ai-wiki import list --pending                    # 2. 查看待判断候选
# 3. Agent 逐条 lark-cli docs +fetch 读内容，再 mark --relevant 做判断（必须基于真实内容）
ai-wiki import mark <token> --relevant true --reason "..."
ai-wiki import mark <token> --relevant false --reason "..."
ai-wiki import approve --all-relevant            # 4. 批准 relevant=true 的候选
ai-wiki import apply                              # 5. 默认预览，不动数据
ai-wiki import apply --yes                        # 6. 必须用户明确批准后才执行真正搬运
ai-wiki import reset <token>... | --all           # 清除判断回 pending，重新判断
```

**双保险：**
1. `apply` 不带 `--yes` 只会预览，绝不动飞书
2. SKILL 规则明文禁止 Agent 在用户未明确同意时自加 `--yes`

首次使用需把以下 scope 加入 lark-cli 登录：

```bash
lark-cli auth login --scope "drive:drive drive:drive:readonly space:document:retrieve wiki:wiki wiki:node:move"
```
（`ai-wiki setup` 会自动申请。）

### 端到端教程

以下是一次完整的批量导入流程，演示每步会看到什么。

#### Step 0 — 前置检查（一次性）

```bash
# 确认 CLI 在 PATH 里
export PATH="$HOME/.npm-global/bin:$PATH"

# 确认已登录 + scope 齐全
ai-wiki user
# → {"name":"...","open_id":"..."}

# 确认 import 目的地已配置
ai-wiki status
# → {"cache":"ready","pages":N}
```

如果 `user` 返回 `unknown`，跑 `ai-wiki setup`。

#### Step 1 — 告诉 Agent"批量录入"

任何一个触发词（"批量录入 / 批量导入 / 批量收录 / 导入我的文档"）都会让 Agent 走 import 流程。**不需要**给 folder_token，Agent 会默认扫"我的空间"根目录。

> 需要扫**子文件夹**时给 Agent 贴云空间 URL：
> `https://bytedance.larkoffice.com/drive/folder/<folder_token>`

#### Step 2 — Agent 扫描

```bash
ai-wiki import scan
```

输出（示例）：

```json
{
  "scanned": 15,
  "new": 15,
  "unchanged": 0,
  "total": 15,
  "candidates_path": "~/.ai-wiki/import-candidates.json"
}
```

此时候选清单全部是 `relevant: null / approved: false`，什么都还没判断。

#### Step 3 — Agent 对每个候选做相关性判断

Agent 会**逐条**读取文档内容（`lark-cli docs +fetch`），基于真实内容写 reason，而不是套模板：

```bash
ai-wiki import mark <token1> --relevant true  --reason "讲 Base 公式引擎增量计算，强相关"
ai-wiki import mark <token2> --relevant false --reason "个人周报，跟 Base 引擎无关"
ai-wiki import mark <token3> --relevant true  --reason "Base 存储层分片设计的技术报告"
# ...
```

如果 Agent 写出"<标题>，相关"这种模板式 reason，说它没读内容，要求它 `lark-cli docs +fetch --as user --doc <token>` 重新判断。

#### Step 4 — 查看 Agent 的判断结果

```bash
ai-wiki import list --pending
# → 仍未判断的条目（应为空，Agent 应已全部打分）

ai-wiki import list --all
# → 看完整清单，重点看 relevant=true 的那些
```

此时可以**自己覆盖** Agent 的判断：

```bash
ai-wiki import mark <token> --relevant false --reason "用户手动排除"
ai-wiki import reset <token>... --all   # 不满意全部判断？全部清空重来
```

#### Step 5 — Agent 一次性展示清单，你一次批准

Agent **不会**一条一条问"这条要不要"，而是**一次性**把所有 `relevant=true` 的候选列给你（格式：`<序号>. <标题> — <reason>`），问：

> "以上 N 条是否全部批准导入？"

你的回复选项：

- **"批准" / "同意" / "可以"** → 代表**全部批准**，Agent 跑 `approve --all-relevant`
- **"除了 X、Y 都可以"** → Agent 先把 X、Y 的 `relevant` 改成 false，再批准剩下的
- **"都不要"** → Agent 跑 `reset --all` 或单条 reject

> 即使你说"批准"，真正搬运**仍需 Step 6、7 的二次确认**（`apply` 预览 + 你再说一次"确认"）—— 双保险防误操作。

#### Step 6 — 预览（强制）

```bash
ai-wiki import apply
```

**不加 `--yes` 就是预览**。输出 `dry_run: true`，完全不动飞书。你会看到 "attempted: N, succeeded: 0, skipped: M" 的 summary，代表"如果真跑 N 条会搬过去"。

#### Step 7 — 明确批准后真搬

对 Agent 说："**确认，批准导入**" 或 "**同意**"。Agent 才能跑：

```bash
ai-wiki import apply --yes
```

输出（示例）：

```json
{
  "attempted": 5,
  "succeeded": 5,
  "failed": 0,
  "skipped": 10,
  "dry_run": false,
  "sync_error": null
}
```

搬成功的条目会在候选 JSON 里获得 `imported_at` 时间戳 + `new_wiki_url`，下次 `apply` 自动 skip。

#### Step 8 — 验证

随便点开一个 `new_wiki_url`，确认它落在**技术库节点**下而不是 AI Wiki 里。

### 常见问题

| 症状 | 原因 / 处理 |
|------|-------------|
| Agent 给所有候选打同样的 reason（套模板）| 它没读文档内容。跑 `ai-wiki import reset --all`，要求它 `lark-cli docs +fetch` 每个 token 后再重判 |
| `missing_scope` 报错 | 重跑 `ai-wiki setup` 或 `lark-cli auth login --scope "..."` |
| 导入到了错的 wiki | 检查 `default-config.json` 的 `import.destination_node_token`，或你本地 `~/.feishu-config.json` 是否覆盖了 |
| 错搬了文档想回滚 | 当前版本不支持自动回滚，在飞书 wiki UI 手动删除或移回云空间；候选 JSON 里那条会保留 `imported_at`，下次 `scan` 不会重新入库 |
| scan 只看到第一页 | 飞书 API 对"我的空间"根目录原生限制。深层文件夹正常分页递归，深入子目录时给 Agent 贴具体 folder_token |

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
