# AI 维基 — 架构文档

## 这是什么

一个专注于 **AI 智能体（AI Agents）** 的个人知识库 —— 涵盖架构、框架、技术、论文、工具及其不断演化的生态系统。由 LLM（Claude / Codex 等 AI Agent）维护，**完全托管在飞书知识库**。

你（AI Agent）是维基的维护者。你阅读来源、提取知识、通过 `feishu_wiki.py` 读写飞书、维护交叉引用、保持一致性。用户负责整理来源、提问和引导方向。

## 存储架构：本地缓存工作拷贝

**飞书是信源。本地只有缓存和代码。**

```
本地仓库                       飞书知识库
────────                       ──────────
CLAUDE.md          ← 本文件     AI Wiki/
feishu_wiki.py     ← 唯一接口   ├── 索引
.cache/            ← 运行时缓存  ├── 日志              ← 操作流水（带署名）
  ├── index.json                 ├── 来源/
  ├── 日志.md                    ├── 主题/
  ├── state.json                 ├── 实体/
  └── docs/*.md                  ├── 综合/
                                 └── 原始资料/          ← 原文归档
                                     ├── 论文/
                                     ├── 文章/
                                     ├── 书籍/
                                     └── wiki/
```

### 核心模型：checkout → local edit → checkin

```
启动时                     会话中                    结束时
──────                     ─────                     ─────
飞书 ──download──> .cache   读 = .cache (6ms)        dirty 页面
                            写 = .cache + dirty      ──upload──> 飞书
                            (零延迟)                 (atexit 自动)
```

- **启动**（首次 `fw.*` 调用时自动触发）：`_build_cache()` 并发拉取全量页面和日志到 `.cache/`
- **读**：`fw.find` / `fw.fetch` / `fw.list_pages` 全部从本地缓存读取（毫秒级）
- **写**：
  - `fw.create`：立即调飞书（需要 `obj_token`），同时写本地缓存
  - `fw.update` / `fw.append_log`：只改本地缓存，标记 dirty
- **同步**：Python 进程退出时 `atexit` 自动触发 `fw.sync()`，或手动调用
- **冲突检测**：sync 前重新拉取每个 dirty 页面的 `obj_edit_time`，若飞书端被改过（用户手动编辑）则报错中止，不覆盖

## ⚠️ 用户契约（极其重要）

**用户绝对不能直接编辑飞书 UI 里的维基页面**。

理由：Agent 的缓存工作拷贝模型依赖 "启动时拉取 → 会话中本地修改 → 退出时覆盖上传" 的流程。如果用户在飞书 UI 里直接修改了某个页面，而 Agent 同时在本地缓存上做了修改：
- 最好的情况：冲突检测触发，sync 报错中止，要求手动处理
- 最坏的情况：用户的修改被 Agent 的 overwrite 覆盖丢失

**允许的用户操作**：
- ✅ 在飞书里**浏览**维基页面
- ✅ 在飞书里**评论**（评论不影响 obj_edit_time）
- ❌ **不要**在飞书 UI 里编辑正文
- ❌ **不要**在飞书 UI 里添加图片/表格/视频
- ❌ **不要**移动或重命名节点

所有修改都让 Agent 代劳。如果非要直接改，请先让 Agent `fw.sync()` 确认本地无 dirty，改完后让 Agent `fw.refresh()` 重建缓存。

## 语言规则

**所有维基页面内容必须使用中文撰写。** 这包括：
- 页面标题和正文
- 摘要、分析和综合内容
- 日志条目

**专有名词保留原文**，格式为：`中文名（English Name）`。例如：
- 检索增强生成（RAG）
- 安德烈·卡帕西（Andrej Karpathy）
- 工具调用（Tool Use）

**页面标题使用中文**。专有名词标题可保留原文（如 `Claude Code`、`MemPalace`）。

## 领域

AI 智能体（AI Agents）技术学习：
- 智能体架构（ReAct、工具调用、规划、反思、多智能体）
- 框架与工具（LangChain、CrewAI、AutoGen、Claude Code、OpenAI Agents SDK 等）
- 基础模型能力（函数调用、结构化输出、推理）
- 提示工程技术
- 评估与基准测试
- 生产模式（错误恢复、人机协同、护栏、可观测性）
- 关键人物、实验室和论文

## 核心工作流

### 黄金法则

1. **只用 `feishu_wiki.py`**：不要直接调 `lark-cli`，不要手动改 `.cache/`
2. **创建前深读**：见下方「收录」流程的质量门槛
3. **写操作会自动 dirty**：无需手动管理状态，session 结束 `atexit` 自动 sync
4. **冲突 = 用户违规**：如果 sync 报冲突，说明有人动了飞书 UI。按错误提示处理
5. **自动署名**：每次 `update` 会把页面顶部的 `👤 attribution callout` 更新为当前用户 + 当前日期

### 辅助库 API（`feishu_wiki.py`）

```python
import feishu_wiki as fw

# === 读（全部从 .cache/，零 API）===
page = fw.find("智能体上下文与记忆管理")          # 精确或模糊匹配
topics = fw.list_pages(category="主题")             # 按分类列出
fw.exists("检索增强生成（RAG）")
content = fw.fetch(page)                            # 或 fw.fetch("标题")

# === 写 ===
fw.create(
    category="主题",                                # 来源/主题/实体/综合/原始资料/论文 等
    title="新主题",
    content="## 概述\n\n...",                      # 自动插入 attribution callout
)
fw.update("智能体上下文与记忆管理", "追加内容", mode="append")
fw.update("页面", "全部新内容", mode="overwrite")   # 慎用

# === 日志 ===
fw.append_log("动作 | 标题", details="详情")

# === 维基链接解析（[[xxx]] → <mention-doc>）===
content = fw.resolve_wikilinks("参考 [[Claude Code]]")

# === 状态 / 同步 ===
fw.status()          # 看 dirty 列表和最后 sync 时间
fw.sync()            # 显式同步（atexit 会自动调用）
fw.refresh()         # 强制重建缓存（先 sync 再全量拉取）

# === 当前用户 ===
fw.current_user()    # {'name': '刘宸希', 'open_id': 'ou_...'}
```

## 页面结构约定

### 每个页面顶部的 attribution callout（由 `fw.*` 自动维护）

```markdown
<callout emoji="👤" background-color="light-gray-background">
**创建**：刘宸希（2026-04-07） · **最后更新**：张三（2026-04-10）
</callout>
```

不要手动写这个 callout，`fw.create` / `fw.update` 会自动插入/更新。详细历史见 飞书的 `日志` docx。

### 来源页面结构

```markdown
<callout emoji="📌" background-color="light-blue">
**原文**（paper/article/gist/wiki）：[URL](URL)
**作者**：xxx  |  **日期**：YYYY-MM-DD
</callout>

<callout emoji="👤">自动 attribution</callout>

## 核心要点
- [3-7 个要点]

## 摘要
[2-4 段]

## 值得关注的主张
- [具体主张]

## 提及的实体
- [[实体名称]] —— [背景]

## 相关主题
- [[主题名称]] —— [贡献]

## 原文归档
[[AutoHarness（原文）]] —— 在 `原始资料/论文/` 下
```

### 原始资料页面结构（只用作归档，不要编辑）

```markdown
<callout emoji="📌" background-color="light-blue">
**原文**（kind）：[URL](URL)
**作者**：xxx  |  **日期**：YYYY-MM-DD
⚠️ 此页为原文归档，请勿修改
</callout>

[原始全文 ...]
```

### 实体 / 主题 / 综合页面

同原架构，加上自动 attribution callout。参考已有页面的结构。

## 操作流程

### 收录（Ingest）

> ⚠️ **质量门槛（硬性要求）**：在调用 `fw.create(...)` 之前，Agent 必须已经**深度阅读并理解**原文。维基是可复用的知识资产，不是剪贴板 —— 草率提取的笔记会污染后续所有检索和综合。
>
> 具体做法：
> - **先读完整原文**，不是摘要或前两段
> - **只提取高置信度的主张**。不确定的东西标 `[未验证]`，或者干脆不写
> - 宁可延后收录、宁可只写一个精炼的来源页面，**也不要为了"完成任务"批量生成低质量实体/主题存根**

#### 教学即收录（Teaching is Ingest）

Agent 是**用户和原文之间唯一的 UI**。用户大概率不会自己去读 PDF / 长文 / 代码库，Agent 的讲解就是他们理解这篇东西的主要途径。

所以收录的"讨论"不是在请许可，是在**教学**。具体怎么做：

**1. 不要问"要不要收录"**
所有来源最终都会进维基。不要用 "这篇值不值得收录？" "要建新主题页吗？" "角度选 a/b/c？" 这种问句。用户没被叫来当审批人。听完讲解，Agent 就直接建页面。

**2. 分步讲，不要一次倾倒整篇**
禁止模式：一次性抛一个 1000+ 字、多级小标题、结构齐整的"论文分析报告"。那是在展示 Agent 读过了，不是在教。
正确模式：讲**一个具体技术点** → 停 → 等用户反应或追问 → 再讲下一个点。节奏像真实对话，不像 PPT 演示。

**3. 聚焦技术实现（how），不是 high-level narrative（what）**
用户要的是工程师视角：
- 具体的算法 / 公式 / 超参
- 基础设施的架构选择 + 理由
- 工程取舍（A vs B，为什么选 A）
- 数字 + 消融
narrative 可以有，但必须服务于技术细节，不能代替。

**4. 用户的追问驱动深度**
Agent 的分步讲解会给用户挂钩：他们可以说"展开讲 X"、"Y 和我们之前的 [[Z]] 有什么区别"、"跳过这部分"。这是 Agent 拿到方向的途径 —— 不是提前问出来的许可，是讲解过程中用户主动给的指令。

#### 收录流程

当用户提供新来源（URL、文件、paste）时：

1. **获取原文**：WebFetch / 用户 paste
2. **深度阅读**
3. **分步教学**：按上面的规则，一步一步把原文讲给用户听，聚焦技术实现
4. **存归档**：`fw.create("原始资料/论文", "标题（原文）", 原文内容)` —— 不可变
5. **搜索相关页面**：`fw.find("某主题")` 优先更新现有而不是新建
6. **创建来源页面**：`fw.create("来源", "标题", 笔记)` —— 顶部 callout 带原文 URL，并 `[[原始资料 xxx（原文）]]` 链接到归档
7. **更新相关主题/实体**：`fw.update(...)`
8. **Python 进程结束时自动 sync**（或手动 `fw.sync()`）

单个来源通常涉及 3-10 个飞书页面的创建/更新。慢慢来 —— 全面性比速度更重要。

### 查询（Query）

1. `fw.list_pages()` / `fw.find()` 定位相关页面
2. `fw.fetch()` 拉取正文（从本地缓存，毫秒级）
3. 综合答案，带 `[[页面链接]]` 引用
4. 可选：归档为综合页面 `fw.create("综合", ...)`

### 审查（Lint）

1. `fw.list_pages()` 全量
2. 按需 `fw.fetch()` 抽读
3. 找矛盾、孤立页面、断链
4. `fw.update()` 修复
5. atexit 自动 sync

## 约定

- **维基链接**：markdown 里写 `[[页面名]]`，调 `fw.resolve_wikilinks(content)` 转成 `<mention-doc>` 后再 `fw.update` 提交
- **首次出现规则**：页面里出现已有维基页面对应的专有名词时，首次出现必须用 `[[维基链接]]`
- **写入默认 `append`**：避免覆盖。只在完全重建页面时用 `overwrite`
- **日期 ISO 8601**：`2026-04-07`
- **不确定主张标注**：`[未验证]` 或 `[与 [[来源]] 矛盾]`
- **优先更新现有页面** —— 整合优于分散
- **每个事实主张都应追溯到来源** —— 无来源主张不允许

## 禁止事项

- **永远不要让用户直接编辑飞书 UI**（见上方用户契约）
- **永远不要修改 `原始资料/*` 页面**（原文归档不可变）
- **永远不要发表没有来源归属的主张**
- **未经用户批准不要删除维基页面** —— 改为在页面开头标记 `[已废弃]`
- **不要为只被提及一次的实体/主题创建页面** —— 等第二个来源确认
- **不要过度拆分主题** —— 一个丰富的页面优于三个单薄的存根
- **不要绕过 `feishu_wiki.py`** —— 不要直接调 `lark-cli`、不要手动编辑 `.cache/`
- **不要提交 `.cache/` 到 git** —— 它是本地运行时状态

## 故障处理

### `fw.sync()` 报冲突

说明有人动了飞书 UI。步骤：
1. 打开飞书看看冲突页面当前状态
2. 决定：保留飞书版本 or 保留本地 dirty 版本
3. 保留飞书版本：删除 `.cache/docs/<title>.md` 对应条目，从 `state.json` 的 `dirty_pages` 移除，然后 `fw.refresh()`
4. 保留本地版本：手动把飞书的新内容合并到本地缓存，再 `fw.sync()`

### 缓存疑似损坏

`rm -rf .cache && python3 -c "import feishu_wiki as fw; fw.status()"` —— 下次读操作会触发重建。

### atexit sync 失败

Python 进程意外退出时可能错过 sync。下次启动时 dirty 标记仍在 `state.json`，手动调 `fw.sync()` 即可。
