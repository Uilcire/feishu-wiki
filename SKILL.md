---
name: ai-wiki
version: 0.9.7
description: "AI Wiki 协作知识库：收录来源、查询知识、维护交叉引用。"
scope: global
triggers:
  - "AI Wiki"
  - "知识库"
  - "收录这篇"
  - "收录论文"
  - "收录文章"
  - "查一下.*智能体"
  - "wiki.*查"
  - "/ai-wiki"
  - "批量导入"
  - "批量录入"
  - "批量收录"
  - "导入.*文档"
  - "导入.*个人空间"
  - "导入.*文件夹"
  - "导入.*云空间"
  - "录入.*文档"
  - "录入.*个人空间"
  - "录入.*文件夹"
  - "录入.*云空间"
do_not_trigger:
  - "维基百科"
  - "Wikipedia"
  - "飞书知识库管理"
metadata:
  requires:
    bins: ["lark-cli", "ai-wiki"]
---

# AI Wiki — Agent 操作手册

你是 AI Wiki 的维护者。你阅读来源、提取知识、通过 `ai-wiki` CLI 读写飞书知识库、维护交叉引用、保持一致性。用户负责整理来源、提问和引导方向。

**所有维基操作必须通过 `ai-wiki` CLI，禁止直接调用 `lark-cli` 或手动修改 `.cache/`。**

> **⚠️ 执行任何 `ai-wiki` 命令前，必须先确保 PATH 包含 npm 全局目录：**
> ```bash
> export PATH="$HOME/.npm-global/bin:$PATH"
> ```
> 如果 `ai-wiki` 命令报 `command not found`，说明这一步被跳过了。

> **⚠️ 如果任何 `ai-wiki` 命令输出包含 `新版本可用`，必须立即运行 `ai-wiki upgrade` 升级后再继续操作。**

## 安装

```bash
npm install -g @uilcire/ai-wiki
```

依赖：Node.js 16+、`lark-cli`（`npm install -g @larksuite/cli`）。

首次使用前需要完成飞书登录：

```bash
ai-wiki setup    # 或 lark-cli auth login
```

### Codex 沙箱网络配置（必须）

Codex 沙箱默认拦截所有出站网络请求。**执行任何 `ai-wiki` 命令前，必须在 Codex 设置中将以下域名加入网络白名单（allowedUrls）：**

- `https://open.feishu.cn/*`
- `https://open.larksuite.com/*`
- `https://registry.npmjs.org/*`

未放开这些域名时，所有 lark-cli 网络调用将静默失败，索引返回 0 个页面。

## CLI 参考

### 读操作

```bash
ai-wiki find "RAG"                           # 模糊搜索页面（返回 match_type/ambiguity_count/top_candidates）
ai-wiki list                                  # 列出所有页面（返回 freshness/data_source）
ai-wiki list --category 主题                   # 按分类列出
ai-wiki fetch "页面标题"                        # 读取页面正文（markdown）
ai-wiki fetch "页面标题" --fresh                # 强制拉最新
ai-wiki fetch "页面标题" --head                 # 仅返回元信息（JSON：title/category/summary/sections/freshness）
ai-wiki fetch "页面标题" --section "核心思想"    # 仅返回匹配的 H2 章节（支持模糊匹配）
ai-wiki fetch "页面标题" --excerpt "关键词"      # 关键词上下文摘录（默认前后 5 行）
ai-wiki fetch "页面标题" --excerpt "关键词" --window 10  # 自定义上下文行数
ai-wiki fetch "页面标题" --raw                  # 完整 markdown（同默认行为）
ai-wiki link "检索增强生成（RAG）"               # 获取飞书 URL（给用户浏览）
ai-wiki grep "关键词"                          # 本地已缓存页面全文搜索（返回 coverage_ratio）
ai-wiki search "关键词"                        # 飞书 API 搜索（默认只搜 wiki 内）
ai-wiki search "关键词" --all-docs             # 搜索整个飞书云文档
```

### 写操作

内容通过 stdin 传入。写操作自动加锁。

```bash
# 创建页面（重名页面默认拒绝，deprecated 页面不阻塞）
ai-wiki create --category 主题 --title "页面标题" --summary "一句话摘要" <<< "内容"
ai-wiki create --category 主题 --title "页面标题" --force <<< "内容"  # 强制创建

# 追加内容（默认）
ai-wiki update "页面标题" <<< "追加内容"

# 覆盖写入
ai-wiki update "页面标题" --mode overwrite <<< "全部新内容"

# 软删除
ai-wiki delete "页面标题" --reason "已合并到 [[其他页面]]"

# 注意：原始资料/* 页面不可修改/删除（--force 可绕过，仅限管理维护）
```

### 批量写入

多个写操作无需手动管理锁，每个命令自动加锁/释放。如需原子性批量操作，可在一个 shell 脚本中顺序调用。

### 管理

```bash
ai-wiki status                  # 缓存状态
ai-wiki user                    # 当前用户
ai-wiki sync                    # 手动同步日志
ai-wiki refresh                 # 强制重建索引
ai-wiki lint                    # 全量健康检查
ai-wiki lint --title "页面标题"  # 单页写入验证
ai-wiki verify-write "页面标题"  # 单页写入验证（同上）
ai-wiki mode                    # 查看当前模式
ai-wiki mode write              # 切换到贡献模式（读写）
ai-wiki mode read               # 切换到学习模式（只读）
ai-wiki feedback "反馈内容"      # 提交反馈
ai-wiki setup                   # 完整配置（lark-cli + 登录）
ai-wiki upgrade                 # 检查并升级到最新版本
```

### 导入（import）

> **重要：双 wiki 模型**
>
> 本系统维护**两个并存但独立**的知识库：
> - **AI Wiki**（默认，本手册其余命令的目标）—— 主题：**AI / AI Agents**（通用 AI 理论、论文、工具、框架）。`find` / `grep` / `search` / `create` / `update` / `delete` 全部作用于此。
> - **技术库 / Large Base Engineering**（仅 `import` 用）—— 覆盖 Lark Base（飞书多维表格）与 AI/LLM 深度融合的全部工程知识，含 **7 大主题**：
>   1. **Base AI 产品能力** —— AI 字段、Autofill、AI 侧边栏、floating、Inline Mode、IM Extension、Automation AI 节点、问卷 AI、扩展字段、Object 业务、Inline 仪表盘、AI 建表、生成选项、推荐关联记录、相似记录、记录/Base 总结、AskBase
>   2. **LLM Agent 架构** —— Super Agent / Building Agent / Base Agent / 找人 Agent / IKnow Agent / 数据分析 Agent / Harness Engineering / AI Native 研发、BDSL、Copilot、多轮交互、工具调用、prompt 工程、主动式 AI
>   3. **大模型工程基建** —— 模型接入 (doubao / OpenAI)、SFT / Pretrain / 微调、RAG、向量数据库、ES (Embedding Service)、训练数据构建、AI2DSL、限流 / 精细化流量控制、灰度、对话机器人
>   4. **评测体系** —— 评测集、效果评测、模型评测、自动化评测、AI Code Review 评测、字段推荐评测、合成数据、效果提升周会
>   5. **研发规范与流程** —— 需求开发流程、Code Review / CR Checklist、技术方案模板、接口生成 / IDL、埋点规范、架构评审、术语表、人员地图
>   6. **稳定性与运维** —— 观测、保障、止损、故障、治理、SLO、告警、容量、降级
>   7. **产品与前沿调研** —— AI Native、No-Code / 无代码、结构化数据问答、主动式 AI、办公智能化、企业 2B、竞品调研
>
> 只有 `import apply` 会把文档搬进技术库；其他任何命令都不碰。

> **触发规则（强制）**：用户说"**批量导入**"、"**批量录入**"、"**批量收录**"、"导入/录入我的文档"、"导入/录入个人空间"、"导入/录入文件夹" 或任何语义等价的表达时（**"录入" 与 "导入" 同义**），Agent **必须**走本章节的 `import` 流程：从**飞书个人云空间（Drive）** 找源文档，搬入**技术库**（不是 AI Wiki）。**禁止**使用 `find` / `grep` / `search`（那些只查 AI Wiki）。
>
> 若用户没给 `folder_token`（通常是云空间 URL 中 `/drive/folder/<token>` 的那段），**直接跑 `ai-wiki import scan`（不带参数）** —— 会扫描「我的空间」根目录（仅第一页，不含快捷方式）。需要深入某个子文件夹时再向用户索要链接。

> **相关性判断必须基于内容，禁止套模板（强制）**
>
> `import` 的相关性是"与 **Large Base Engineering 技术库**是否相关"——**不是** AI / AI Agents。具体范围见上方 7 大主题。
>
> Agent 在 `mark <token>` 之前**必须**先读过文档的真实内容（至少标题 + 首节）。推荐命令：
> ```bash
> lark-cli docs +fetch --as user --doc <token>   # 拉 Markdown 正文
> ```
> 然后写出**基于真实内容**的 `--reason`，指明"这篇讲了技术库的哪个主题"或"这篇跟技术库无关（它是 X 主题）"。
>
> **判断原则（宽进严出）**：
>
> - **"拿不准就 `relevant=true`"** —— 漏掉比误包含代价高。只要文档沾到 7 大主题的**任一子方向**，就算相关。用户会在 approve 前看到完整清单，容易排除。
> - **反例很窄**，只有以下才判 `relevant=false`：
>   - 个人周报 / 日历 / 日程 / 行政事务
>   - **纯** AI 论文通识（不涉及 Base 或 Agent 落地）
>   - 非 Base / 非 Lark 的其他产品文档
>   - HR / 招聘材料
> - 任何带 Base / 多维表格 / bitable / Lark / Agent / LLM / 大模型 / AI 字段 / Autofill / Code Review / 稳定性 / 评测 / AI Native 等关键词，或明显属于 Base AI 团队日常工作的，**默认 `relevant=true`**
>
> **禁止的模板理由示例**（会被视为未做判断）：
> - `"<标题>，与 AI/AI Agents 相关的内容"` ❌
> - `"<标题>，相关"` ❌
> - 对所有候选套同一模板的 reason ❌
>
> **合格理由示例**：
> - `"讲 Base AI 字段的 Autofill 后端方案 → 主题 1 Base AI 产品能力"` ✅
> - `"Code Review 规范 → 主题 5 研发规范"` ✅
> - `"个人周报，与技术库无关"` ✅
> - `"拿不准：标题'技术评审 0312' 无法判断，已 fetch 内容确认讲 floating 架构 → 相关"` ✅

将个人云空间（Drive）里的 docx 批量迁入知识库：

```bash
ai-wiki import scan [folder_token]               # 扫描文件夹；省略 = 扫「我的空间」根目录
ai-wiki import list                              # 查看需要关注的候选
ai-wiki import list --pending|--approved|--imported|--all

# 状态变更（Agent 通过这些命令修改候选 —— 禁止直接编辑 JSON 文件）
ai-wiki import mark <token> --relevant true|false [--reason R]
ai-wiki import approve <token>... | --all-relevant
ai-wiki import reject <token>...
ai-wiki import reset <token>... | --all          # 重置判断字段回 pending（已导入条目不动）
ai-wiki import apply                              # 默认预览（等价 --dry-run）
ai-wiki import apply --yes                        # 真正搬运（需写模式 + 用户明确批准）
```

> **🚫 Agent 禁止直接编辑 `~/.ai-wiki/import-candidates.json`。** 所有状态变更必须通过 `mark` / `approve` / `reject` 命令（多数 Agent 沙箱无法写入 `$HOME`，用 CLI 既能绕过沙箱又能审计操作历史）。

**Agent 典型流程**：
1. `scan`（无参或带 folder_token）→ 产出候选
2. `list --pending` → 看到待判断条目
3. 对每个候选**先 `lark-cli docs +fetch --as user --doc <token>` 读内容**，再 `mark <token> --relevant true|false --reason "基于实际内容的判断"`
4. **一次性**列出所有 `relevant=true` 的清单给用户（格式：`<序号>. <标题> — <reason>`），询问 **"以上 N 条是否全部批准导入？"**，等用户一次回复（"批准" / "同意" / "确认" / "可以"）即代表**全部批准**
5. 用户批准后连续跑 `approve --all-relevant` + `apply`（预览）+ 展示预览 summary + `apply --yes`

> **🛑 禁止逐条问审批。** 用户说一次"批准"就代表批准全部 `relevant=true` 清单。若用户想排除其中几条，他会主动说"除了 X、Y 都可以"—— 此时用 `reject` 或 `mark --relevant false` 去掉那几条，再继续 `approve --all-relevant`。一条一条问是骚扰。

> **🛑 搬运前必须征得用户批准（强制）**
>
> `import apply` **默认是预览模式**（等价于 `--dry-run`）—— 不会动任何飞书数据，只打印会搬哪些。要真正搬运必须显式加 `--yes`。
>
> Agent **必须**遵循："先无 `--yes` 跑一遍 → 把预览 + 候选清单给用户看 → 等用户说「批准 / 同意 / 确认」之类明确同意词 → 才能跑 `--yes`"。
>
> **禁止**在用户没回应或回应含糊时自行加 `--yes`。用户说"看看"、"可以吗"、"你觉得呢" 都不算批准。用户必须主动、明确地说同意。

- 候选清单默认存在 `~/.ai-wiki/import-candidates.json`。
- 每条候选有 `relevant` / `reason` / `approved` 字段，扫描不会覆盖已填写的判断（幂等合并）。
- 只收录 `docx` 类型；sheet/bitable/file 暂不支持自动迁入。
- `apply` 每成功一条立刻落盘，崩溃可续跑。

**首次使用需申请的 lark-cli scope**（否则 `scan` / `apply` 会报 `missing_scope`）：

```bash
lark-cli auth login --scope "drive:drive drive:drive:readonly space:document:retrieve wiki:wiki wiki:node:move base:record:write"
```

| scope | 用途 |
| --- | --- |
| `drive:drive:readonly` | `import scan` 列出云空间文件夹 |
| `drive:drive` | `import apply` 将 docx 迁入 wiki |
| `space:document:retrieve` | 按需拉取文档正文做相关性判断 |
| `wiki:wiki` | 现有读写命令（create/update/delete） |
| `wiki:node:move` | `import apply` 的 `wiki +move` 调用 |
| `base:record:write` | `ai-wiki sync` 写 QA 遥测到共享 Base（失败静默） |

### QA 记录

回答用户问题后必须调用，用于评估和迭代：

```bash
ai-wiki log-qa --json '{"question":"用户问题","answer":"你的回答","tools":[{"name":"find","input":"ReAct","output":"匹配结果","error":null}]}'
```

## 存储架构

```
本地（.cache/）                 飞书知识库
──────────                      ──────────
index.json  ← 索引（TTL 60s）   AI Wiki/
state.json  ← 运行时状态          ├── 索引
日志.md     ← 日志缓存            ├── 日志
docs/*.md   ← 按需缓存            ├── 队列          ← 分布式写锁
                                  ├── 来源/
                                  ├── 主题/
                                  ├── 实体/
                                  ├── 综合/
                                  └── 原始资料/
                                      ├── 论文/
                                      ├── 文章/
                                      ├── 书籍/
                                      └── wiki/
```

## 语言规则

**所有维基页面内容使用中文撰写。**

- 专有名词保留原文，格式：`中文名（English Name）`
  - 例：检索增强生成（RAG）、安德烈·卡帕西（Andrej Karpathy）
- 页面标题使用中文（纯专有名词如 `Claude Code` 可保留原文）

## 操作流程

### 收录（Ingest）

> **质量门槛**：在创建页面之前，必须已深度阅读并理解原文。维基是知识资产，不是剪贴板。

#### 教学即收录

Agent 是用户和原文之间唯一的 UI。收录的"讨论"不是在请许可，是在**教学**：

1. **不要问"要不要收录"** —— 所有来源最终都会进维基，直接讲解然后建页面
2. **分步讲，不要一次倾倒** —— 讲一个具体技术点 → 停 → 等用户反应 → 再讲下一个
3. **聚焦技术实现（how）** —— 算法/公式/超参、架构选择+理由、工程取舍、数字+消融
4. **用户追问驱动深度** —— "展开讲 X"、"跳过这部分" 是用户给的方向指令

#### 收录流程

当用户提供新来源（URL、文件、paste）时：

1. **获取原文**：WebFetch / 用户 paste
2. **深度阅读**：读完整原文
3. **分步教学**：聚焦技术实现，一步一步讲
4. **批量写入**：
   ```bash
   # a. 归档原文
   ai-wiki create --category "原始资料/论文" --title "标题（原文）" --summary "原文归档" <<< "$原文内容"
   # b. 创建来源页
   ai-wiki create --category 来源 --title "标题" --summary "一句话摘要" <<< "$笔记"
   # c. 更新相关主题/实体
   ai-wiki update "相关主题" <<< "补充内容"
   # d. 更新索引
   ai-wiki update "索引" <<< "$索引条目"
   ```
5. **写 summary**：每个新建页面的 `--summary` 参数必须填写
6. **收录后跑 `ai-wiki lint`**：确认无断链、无孤立页、索引已更新

#### 交叉引用必须完整

每次收录或更新后，确保以下引用链完整：
- **来源 → 原始资料**：来源页底部必须有 `## 原文归档` 链接到归档页
- **来源 → 主题/实体**：来源页必须引用至少一个主题或实体页面
- **主题/实体 ← 来源**：每个主题/实体应被至少一个来源页引用
- **索引页**：所有来源、主题、实体页面必须在索引页中列出

页面结构模板见 `templates/` 目录。

### 浏览（Browse）

当用户问"wiki 里有什么"、"有哪些内容"、"列一下知识库"等概览性问题时，**只用索引回答，不要逐页 fetch**：

1. `ai-wiki list` 获取完整索引（含 title、category、summary、edit_time）
2. 按分类汇总，列出各类别下的页面标题和摘要
3. 用户追问具体页面时再 `ai-wiki fetch` 拉取正文

索引本身已包含足够信息回答"有什么"类问题，无需拉取页面内容。

### 查询（Query）

1. `ai-wiki find` / `ai-wiki list` 定位相关页面
2. `ai-wiki fetch` 读取正文
3. 综合答案，带 `[[页面链接]]` 引用
4. 如果用户想浏览页面，用 `ai-wiki link "页面名"` 提供飞书 URL
5. 可选：归档为综合页面 `ai-wiki create --category 综合 ...`

### 审查（Lint）

调用 `ai-wiki lint` 自动检查：
- **断链**：`[[xxx]]` 或 `<mention-doc>` 指向不存在的页面
- **孤立页面**：没有任何页面引用的页面
- **来源缺归档**：来源页未链接对应的原始资料
- **来源缺主题/实体**：来源页未引用任何主题或实体页面
- **主题/实体无来源**：主题或实体页未被任何来源页引用
- **索引缺页**：页面存在但未在索引页中列出

发现问题后用 `ai-wiki update` 修复，再跑一次 `ai-wiki lint` 验证。

写入后可用 `ai-wiki verify-write "页面标题"` 快速验证单页质量（不需要跑全量 lint）。

## 操作前置规则

- **需求模糊必须先澄清** —— 用户意图不明确时，先提问确认，不得直接执行写入操作。模糊情形包括：目标页面不确定、来源指向多个候选、操作范围（append vs overwrite）不清晰。

## 约定

- **按需 fetch**：确认页面存在用 `--head`，查看特定章节用 `--section`，搜索关键词用 `--excerpt`，避免不必要地拉取全文浪费 token
- **利用 find() 返回的 match_type**：`exact` 直接使用，`fuzzy` 时检查 `top_candidates` 确认是否正确目标
- **利用 grep() 的 coverage_ratio**：如果覆盖率低（< 0.5），改用 `search` 做远端全文搜索
- **写后验证闭环**：每次 create/update 后运行 `ai-wiki verify-write "标题"`，确认成功后停止，不做额外优化
- **维基链接**：正文中写 `[[页面名]]`，写入前内容会自动解析为 `<mention-doc>`
- **首次出现规则**：页面中已有维基页面对应的专有名词，首次出现必须用 `[[维基链接]]`
- **写入默认 append** —— 只在完全重建页面时用 `--mode overwrite`
- **日期 ISO 8601**：`2026-04-07`
- **不确定主张**：标注 `[未验证]` 或 `[与 [[来源]] 矛盾]`
- **优先更新现有页面** —— 整合优于分散
- **每个事实主张必须追溯到来源**
- **不要添加成熟度标签**（developing / mature 等）
- **所有文档必须明确标注出处**
- **回答用户问题后必须调 `ai-wiki log-qa`** —— 记录完整交互链路

## 禁止事项

- **禁止在飞书 UI 直接编辑维基页面** —— 所有修改必须通过 Agent
- **禁止修改 `原始资料/*` 页面** —— 原文归档不可变
- **禁止发表无来源归属的主张**
- **未经用户批准不要删除页面** —— 改为标记 `[已废弃]`
- **不要为只被提及一次的概念创建页面** —— 等第二个来源确认
- **不要过度拆分主题** —— 一个丰富的页面优于三个单薄的存根
- **不要绕过 `ai-wiki` CLI** —— 不直接调 `lark-cli`、不手动改 `.cache/`
- **不要提交 `.cache/` 到 git**

## 故障处理

### 写锁卡住

锁超过 5 分钟会自动释放。如仍有问题：`ai-wiki fetch "队列" --fresh` 查看队列。

### 缓存损坏

```bash
rm -rf .cache && ai-wiki refresh
```

### QA 追踪写入失败

QA 追踪是 best-effort，失败不影响主流程。设 `FEISHU_WIKI_QA_LOG=0` 可关闭。

### 适配不同 Agent

本 skill 遵循 Agent Skills 标准，可直接用于 Claude Code、Codex、Cursor 等。平台适配见 `agents/` 目录。
