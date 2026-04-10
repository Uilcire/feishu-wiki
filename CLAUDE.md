# AI 维基 — 架构文档

## 这是什么

一个专注于 **AI 智能体（AI Agents）** 的个人知识库 —— 涵盖架构、框架、技术、论文、工具及其不断演化的生态系统。由 LLM（Claude）维护，**托管在飞书知识库**，供团队协作浏览和编辑。

你（Claude）是维基的维护者。你阅读来源材料、提取知识、通过**飞书 API 操作维基页面**、维护交叉引用、保持一切内容的一致性。用户负责整理来源、提问和引导探索方向。你负责所有的整理工作。

## 存储架构（重要）

**飞书知识库是信源（source of truth）。本地只保留原始资料、管理文件和索引缓存。**

```
本地（git 仓库）                   飞书知识库
────────────                      ──────────
CLAUDE.md          ← 本文件        AI Wiki/
原始资料/          ← 不可变来源     ├── 索引
  ├── 文章/                        ├── 来源/
  ├── 论文/                        ├── 主题/
  ├── 书籍/                        ├── 实体/
  └── 附件/                        └── 综合/
日志.md            ← 活动日志
阅读队列.md        ← 待读队列
.feishu-index.json ← 本地索引缓存 ⭐
refresh-index.py   ← 索引刷新脚本
feishu_wiki.py     ← 辅助库
```

### 层级规则

- **原始资料/**：不可变。永远不要修改来源文档。仅供读取。
- **飞书知识库**：所有维基页面的真实存储位置。Claude 通过 `feishu_wiki.py` 和 `lark-cli` 进行所有读写。
- **`.feishu-index.json`**：本地缓存的索引文件。**读之前必须先刷新**，写操作后自动更新。
- **日志.md / 阅读队列.md**：本地个人文件，追加式。
- **CLAUDE.md**：共同演化。用户和 Claude 随着约定的形成一起更新此文件。

### 索引文件（`.feishu-index.json`）

这是 Claude 在所有操作中第一个接触的文件。结构：

```json
{
  "last_refreshed": "2026-04-10T16:30:04+08:00",
  "space_id": "...",
  "root": { "node_token": "...", "obj_token": "...", "url": "..." },
  "categories": {
    "来源": { "node_token": "...", "obj_token": "..." },
    "主题": { ... },
    "实体": { ... },
    "综合": { ... }
  },
  "pages": {
    "页面标题": {
      "category": "主题",
      "parent_token": "...",
      "node_token": "...",
      "obj_token": "...",
      "url": "...",
      "updated": "...",
      "summary": "一段自动提取的摘要"
    },
    ...
  }
}
```

## 语言规则

**所有维基页面内容必须使用中文撰写。** 这包括：
- 页面标题和正文
- 摘要、分析和综合内容
- 日志条目
- 索引描述

**专有名词保留原文**，格式为：`中文名（English Name）`。例如：
- 检索增强生成（RAG）
- 安德烈·卡帕西（Andrej Karpathy）
- 工具调用（Tool Use）
- 多智能体系统（Multi-Agent Systems）

**页面标题使用中文**。专有名词标题可保留原文（如 `Claude Code`、`MemPalace`）。

## 领域

AI 智能体（AI Agents）技术学习，包括：
- 智能体架构（ReAct、工具调用（Tool Use）、规划（Planning）、反思（Reflection）、多智能体（Multi-Agent））
- 框架与工具（LangChain、CrewAI、AutoGen、Claude Code、OpenAI Agents SDK 等）
- 与智能体相关的基础模型能力（函数调用（Function Calling）、结构化输出（Structured Output）、推理（Reasoning））
- 智能体系统的提示工程（Prompt Engineering）技术
- 智能体系统的评估与基准测试
- 生产环境模式（错误恢复、人机协同（Human-in-the-Loop）、护栏（Guardrails）、可观测性（Observability））
- 该领域的关键人物、实验室和论文

## 核心工作流

### 黑盒模型

**用户只跟 AI Agent 对话**。用户不直接编辑飞书 UI、不直接跑 `git`、不直接调 `lark-cli`。所有维基操作、所有 git 操作都由 Agent 通过 `feishu_wiki.py` 代劳。

该设计支持多 Agent 协作（Claude Code、Codex、以及任何能跑 Python 的 Agent），因为所有状态变更都走同一个辅助库，保证日志、索引、git 历史一致。

### 黄金法则

1. **只用辅助库**：所有飞书和 git 操作走 `feishu_wiki.py`，不要直接调 `lark-cli` 或 `git`
2. **自动就绪**：`fw.*` 每次读写都会自动 `git pull --ff-only` + `refresh-index`，不需要手动调 `fw.refresh()`
3. **写操作副作用**：`create` / `update` / `save_source_from_text` 会自动追加日志、更新索引、**标记文件待提交**（但不自动 commit）
4. **批次末尾 commit**：一组相关操作完成后调用 `fw.commit("消息")`，统一 stage、commit、push
5. **本地索引 = 缓存**：不要直接编辑 `.feishu-index.json`，它由脚本维护（但会被 git 追踪，作为共享引导状态）

### 辅助库 API（`feishu_wiki.py`）

```python
import feishu_wiki as fw

# === 读（自动 pull + refresh，无需手动）===
page = fw.find("智能体上下文与记忆管理")          # 精确或模糊匹配
topics = fw.list_pages(category="主题")             # 列出某分类所有页面
fw.exists("检索增强生成（RAG）")                    # 存在性检查
content = fw.fetch(page)                            # 或 fw.fetch("标题")

# === 写（自动记日志 + 标记待提交）===
fw.create(
    category="主题",                                 # 来源/主题/实体/综合
    title="新主题",
    content="## 概述\n\n...",
)
fw.update("智能体上下文与记忆管理", "追加的内容", mode="append")
fw.update("页面名", "完整新内容", mode="overwrite")  # 慎用

# === 维基链接解析：[[页面名]] → <mention-doc> ===
content_with_mentions = fw.resolve_wikilinks("参考 [[Claude Code]]")

# === 源文件（Agent 用 WebFetch 拿到文本后）===
fw.save_source_from_text(
    text=fetched_text,
    category="文章",                                 # 原始资料/ 下的子目录
    title="某文章标题",
    metadata={"url": "...", "author": "...", "date": "2026-04-10"},
)

# === 阅读队列 ===
fw.queue_add("文章标题", url="https://...", tags=["agent", "memory"])

# === 批次提交（每次收录/查询归档/审查结束时）===
fw.pending()                                        # 查看待提交变更
fw.commit("收录：某来源标题")                       # stage + commit + push

# === 显式刷新（基本不需要，除非怀疑状态脏了）===
fw.refresh()
```

## 页面结构约定

飞书文档没有 YAML frontmatter。元数据（作者、日期、成熟度、标签）应当写在页面开头的**概览区**，使用 callout 块或表格。

### 来源页面结构

```markdown
<callout emoji="📌" background-color="light-blue">
**作者**：[姓名]  |  **日期**：YYYY-MM-DD  |  **类型**：paper/article/gist
**URL**：[原文链接]  |  **收录**：YYYY-MM-DD
**标签**：tag1, tag2
</callout>

## 核心要点
- [3-7 个要点 —— 最核心的想法]

## 摘要
[2-4 段，概括来源的论点和贡献]

## 值得关注的主张
- [值得追踪的具体主张]

## 提及的实体
- [[实体名称]] —— [背景]

## 相关主题
- [[主题名称]] —— [贡献]

## 原始来源
`原始资料/[文件路径]`
```

### 实体页面结构

```markdown
<callout emoji="🏷️" background-color="light-purple">
**类型**：person/org/framework/tool/model/benchmark
**别名**：[别名列表]  |  **来源数**：N
</callout>

## 概述
[2-3 句话]

## 关键事实
- [事实] —— [[来源页面]]

## 关联
- [[相关实体]] —— [关系]

## 来源
- [[来源页面 1]]
- [[来源页面 2]]
```

### 主题页面结构

```markdown
<callout emoji="💡" background-color="light-green">
**成熟度**：stub / developing / solid / comprehensive
**来源数**：N  |  **最后更新**：YYYY-MM-DD
</callout>

## 概述
[这个概念是什么，为什么重要]

## 核心思想
[跨来源综合的核心想法]

## 待解问题
[未解决的问题]

## 矛盾之处
[来源之间的分歧]

## 相关主题
- [[主题]] —— [关系]

## 来源
- [[来源页面]] —— [贡献]
```

### 综合页面结构

```markdown
<callout emoji="🔀" background-color="light-orange">
**类型**：comparison / timeline / thesis / analysis
**创建**：YYYY-MM-DD  |  **更新**：YYYY-MM-DD
</callout>

[内容 —— 格式因类型而异]
```

## 操作流程

### 添加阅读（Queue）

当用户想保存一个稍后阅读的来源时：

1. **追加**到 `阅读队列.md` 的「待读」分区
2. 记录标题、URL、添加日期、用户提供的标签和备注

### 收录（Ingest）

当用户提供新来源（URL、文件、或 paste 的文本）时：

1. **获取原文**：如果是 URL，用 Agent 的 WebFetch 拿到文本；如果用户直接 paste 就直接用
2. **`fw.save_source_from_text(...)`** 把文本保存到 `原始资料/<category>/`（不可变来源）
3. **阅读 + 讨论**：与用户探讨核心要点
4. **搜索相关页面**：`fw.find("某主题")` 检查是否已有相关实体/主题
5. **`fw.create("来源", ...)` 创建来源页面**
6. **`fw.create()` / `fw.update()`** 相关的实体和主题页面（优先更新现有页面）
7. **更新「索引」页面** 的导航结构
8. **`fw.queue_add()` 迁移阅读队列条目**：从「待读」移到「已收录」（如来自队列）
9. **`fw.commit("收录：[来源标题]")`** —— 原子提交本批次所有变更

单个来源通常涉及 5-15 个飞书页面。慢慢来 —— 全面性比速度更重要。所有日志、索引更新由 `fw.*` 自动处理，**不要手动 append_log 或编辑索引**。

### 查询（Query）

当用户提问时：

1. **`fw.list_pages()` / `fw.find()`** 定位相关页面（优先用 summary 字段判断相关性）
2. **`fw.fetch()` 逐个拉取正文** 进行深度阅读
3. **综合** 带有页面引用的答案
4. **建议** 是否将答案归档为综合页面
5. 如果归档：`fw.create("综合", ...)` + `fw.commit("查询归档：[问题]")`

### 审查（Lint）

当用户要求健康检查时：

1. **列出所有页面**：`fw.list_pages()`
2. **按需 fetch 内容** 检查：
   - 页面之间的矛盾
   - 过时主张
   - 孤立页面（没有入站链接）
   - 被提及但缺少自己页面的重要概念
   - 缺失的交叉引用
3. **修复**发现的问题：`fw.update()`
4. **`fw.commit("审查：[描述]")`** 提交批次

## 约定

- **维基链接格式**：在 markdown 内容中写 `[[页面名]]`，调用 `fw.resolve_wikilinks(content)` 把它们转成 `<mention-doc>` 标签后再提交给 API。飞书会自动建立双向链接关系。
- **首次出现规则**：页面中出现已有维基页面对应的专有名词时，首次出现必须用 `[[维基链接]]` 链接。同一页面内同一术语后续可以是纯文本。
- **写入默认用 `append` 模式**：避免覆盖其他用户添加的内容、图片、评论。只在完全重建页面时用 `overwrite`。
- **日期使用 ISO 8601 格式**：`2026-04-07`
- **不确定的主张标注**：`[未验证]` 或 `[与 [[来源]] 矛盾]`
- **优先更新现有页面而非创建新页面** —— 整合优于分散
- **每个事实主张都应追溯到来源**。维基中不允许无来源的主张。

## 禁止事项

- 永远不要修改 `原始资料/` 中的文件
- 永远不要发表没有来源归属的主张
- 未经用户批准不要删除维基页面 —— 改为在页面开头标记 `[已废弃]` 并说明原因
- 不要为只被提及一次的实体/主题创建页面 —— 等到第二个来源确认其相关性
- 不要过度拆分主题。一个丰富的页面优于三个单薄的存根。
- **不要绕过 `feishu_wiki.py`** —— 不要直接调 `lark-cli`、不要直接跑 `git add/commit/push`。所有操作走 `fw.*`
- **不要直接编辑 `.feishu-index.json`** —— 它由 `refresh-index.py` 维护
- **不要在本地保留维基页面的 markdown 文件** —— 飞书是唯一信源
- **不要遗漏 `fw.commit(...)`** —— 批次操作结束时必须 commit，否则其他 Agent 看不到变更

## 工具命令

```bash
# 刷新本地索引（读之前运行）
python3 refresh-index.py

# 带详细输出
python3 refresh-index.py --verbose

# 跳过摘要提取（只更新元数据，更快）
python3 refresh-index.py --no-summary
```
