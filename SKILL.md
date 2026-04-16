---
name: ai-wiki
version: 0.6.0
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

## CLI 参考

### 读操作

```bash
ai-wiki find "RAG"                           # 模糊搜索页面
ai-wiki list                                  # 列出所有页面
ai-wiki list --category 主题                   # 按分类列出
ai-wiki fetch "检索增强生成（RAG）"              # 读取页面正文（markdown）
ai-wiki fetch "页面标题" --fresh                # 强制拉最新
ai-wiki link "检索增强生成（RAG）"               # 获取飞书 URL（给用户浏览）
ai-wiki grep "关键词"                          # 本地已缓存页面全文搜索
ai-wiki search "关键词"                        # 飞书 API 搜索（默认只搜 wiki 内）
ai-wiki search "关键词" --all-docs             # 搜索整个飞书云文档
```

### 写操作

内容通过 stdin 传入。写操作自动加锁。

```bash
# 创建页面
ai-wiki create --category 主题 --title "页面标题" --summary "一句话摘要" <<< "内容"

# 追加内容（默认）
ai-wiki update "页面标题" <<< "追加内容"

# 覆盖写入
ai-wiki update "页面标题" --mode overwrite <<< "全部新内容"

# 软删除
ai-wiki delete "页面标题" --reason "已合并到 [[其他页面]]"
```

### 批量写入

多个写操作无需手动管理锁，每个命令自动加锁/释放。如需原子性批量操作，可在一个 shell 脚本中顺序调用。

### 管理

```bash
ai-wiki status                  # 缓存状态
ai-wiki user                    # 当前用户
ai-wiki sync                    # 手动同步日志
ai-wiki refresh                 # 强制重建索引
ai-wiki lint                    # 健康检查
ai-wiki mode                    # 查看当前模式
ai-wiki mode write              # 切换到贡献模式（读写）
ai-wiki mode read               # 切换到学习模式（只读）
ai-wiki feedback "反馈内容"      # 提交反馈
ai-wiki setup                   # 完整配置（lark-cli + 登录）
ai-wiki upgrade                 # 检查并升级到最新版本
```

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

## 操作前置规则

- **需求模糊必须先澄清** —— 用户意图不明确时，先提问确认，不得直接执行写入操作。模糊情形包括：目标页面不确定、来源指向多个候选、操作范围（append vs overwrite）不清晰。

## 约定

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
