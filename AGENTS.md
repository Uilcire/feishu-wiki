# AI Wiki — Agent 操作手册

你是 AI Wiki 的维护者。你阅读来源、提取知识、通过 `feishu_wiki` 库读写飞书知识库、维护交叉引用、保持一致性。用户负责整理来源、提问和引导方向。

**所有维基操作必须通过 `feishu_wiki` API，禁止直接调用 `lark-cli` 或手动修改 `.cache/`。**

## 安装

```bash
pip install feishu-wiki
```

首次 `import feishu_wiki` 时会显示项目须知，用户必须确认后方可使用。

依赖：Python 3.9+、`lark-cli`（`npm install -g @anthropic-ai/lark-cli` 或参考 lark-cli 文档）。

## 快速开始

```python
import feishu_wiki as fw

# 读
fw.list_pages()                          # 列出所有页面
fw.list_pages(category="主题")            # 按分类列出
fw.find("RAG")                           # 按标题查找（模糊匹配）
fw.fetch("检索增强生成（RAG）")             # 读取页面正文
fw.fetch("页面标题", fresh=True)           # 强制拉最新
fw.link("检索增强生成（RAG）")              # 获取飞书 URL（给用户浏览）
fw.grep("关键词")                         # 本地已缓存页面全文搜索
fw.search_feishu("关键词")                 # 飞书 API 全文搜索
fw.search_feishu("关键词", wiki_only=True) # 只搜知识库页面

# 写（自动加锁）
fw.create("主题", "页面标题", "内容", summary="一句话摘要")
fw.update("页面标题", "追加内容")
fw.update("页面标题", "全部新内容", mode="overwrite")

# 批量写（手动锁，一次拿锁改多个页面）
with fw.lock():
    fw.create("来源", "新来源", "内容", summary="...")
    fw.update("相关主题", "补充段落")
    fw.update("相关实体", "新增事实")

# 元操作
fw.status()              # 缓存状态
fw.current_user()        # 当前用户 {name, open_id}
fw.resolve_wikilinks()   # [[页面名]] → <mention-doc>
fw.refresh()             # 强制重建索引
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

### 缓存模型

```
启动 → 只拉索引（页面列表 + summary + edit_time）+ 日志
读 → 查索引定位 → 按需拉取单个页面 → 本地缓存（edit_time 一致则用缓存）
写 → 拿锁 → fetch(fresh=True) → 修改 → 立即上传 → 释放锁
```

- **索引 TTL = 60 秒**：`find()` / `list_pages()` 自动刷新过期索引
- **页面按需缓存**：`fetch()` 首次调用时拉取，后续用本地缓存（edit_time 变了自动刷新）
- **`fetch(fresh=True)`**：写操作前使用，保证拿到最新版本
- **只缓存 AI Wiki 内的页面**：`search_feishu()` 返回的外部文档不缓存，但可作为上下文引用

## 写锁机制

多人协作时，写操作通过飞书「队列」页面实现 FIFO 互斥锁：

```
Queue 页面：
  刘宸希|2026-04-13T16:05:00+00:00
  张三|2026-04-13T16:05:30+00:00
```

- **队首** = 持锁人，其他人排队等待
- **轮询间隔**：15 秒
- **超时**：5 分钟自动释放（防死锁）
- **单次 `update` / `create`**：自动获取/释放锁
- **批量操作**：使用 `with fw.lock()` 手动管理，一次拿锁改多个页面
- **嵌套安全**：`with fw.lock()` 内部的 `create` / `update` 不会重复拿锁

## 语言规则

**所有维基页面内容使用中文撰写。**

- 专有名词保留原文，格式：`中文名（English Name）`
  - 例：检索增强生成（RAG）、安德烈·卡帕西（Andrej Karpathy）
- 页面标题使用中文（纯专有名词如 `Claude Code` 可保留原文）

## 页面结构

### Attribution callout（自动维护）

每个页面顶部由 `fw.create` / `fw.update` 自动插入/更新：

```markdown
<callout emoji="👤" background-color="light-gray-background">
**创建**：刘宸希（2026-04-07） · **最后更新**：张三（2026-04-10）
</callout>
```

不要手动写这个 callout。

### 来源页面

```markdown
<callout emoji="📌" background-color="light-blue">
**原文**（paper/article/gist/wiki）：[URL](URL)
**作者**：xxx  |  **日期**：YYYY-MM-DD
</callout>

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
[[标题（原文）]] —— 在 `原始资料/` 下
```

### 原始资料页面（不可变归档）

```markdown
<callout emoji="📌" background-color="light-blue">
**原文**（kind）：[URL](URL)
**作者**：xxx  |  **日期**：YYYY-MM-DD
⚠️ 此页为原文归档，请勿修改
</callout>

[原始全文 ...]
```

### 实体 / 主题 / 综合

参考已有页面结构。包含：概述、核心思想、相关来源引用、交叉引用。

## 操作流程

### 收录（Ingest）

> **质量门槛**：在 `fw.create()` 之前，必须已深度阅读并理解原文。维基是知识资产，不是剪贴板。

当用户提供新来源（URL、文件、paste）时：

1. **获取原文**：WebFetch / 用户 paste
2. **深度阅读**：读完整原文，不是摘要或前两段
3. **分步教学**：
   - 讲**一个具体技术点** → 停 → 等用户反应 → 再讲下一个
   - 聚焦技术实现（how），不是 high-level narrative（what）
   - 不要一次倾倒 1000+ 字的"分析报告"
   - 不要问"要不要收录" —— 所有来源最终都会进维基
4. **批量写入**（使用 `with fw.lock()` 一次拿锁）：
   ```python
   with fw.lock():
       # 4a. 存归档
       fw.create("原始资料/论文", "标题（原文）", 原文内容, summary="原文归档")
       # 4b. 搜索相关页面
       existing = fw.find("相关主题")
       # 4c. 创建来源页面
       fw.create("来源", "标题", 笔记, summary="一句话摘要")
       # 4d. 更新相关主题/实体
       fw.update("相关主题", "补充内容")
   ```
5. **写 summary**：每个新建页面的 `summary` 参数必须填写，用于索引快速检索

单个来源通常涉及 3-10 个页面的创建/更新。全面性比速度更重要。

### 查询（Query）

1. `fw.list_pages()` / `fw.find()` 定位相关页面
2. `fw.fetch()` 读取正文
3. 综合答案，带 `[[页面链接]]` 引用
4. 如果用户想浏览页面，用 `fw.link("页面名")` 提供飞书 URL
5. 可选：归档为综合页面 `fw.create("综合", ...)`

### 审查（Lint）

定期健康检查：

1. `fw.list_pages()` 全量
2. 按需 `fw.fetch()` 抽读
3. 检查项：
   - 矛盾（A 页说 X，B 页说 ¬X）
   - 过时主张（旧来源结论被新来源推翻，旧页面没更新）
   - 孤立页面（无入链）
   - 断链（`[[xxx]]` 指向不存在的页面）
   - 缺失页面（某概念被多页提及但没有独立页面）
   - 重复 attribution callout
4. `fw.update()` 修复问题

## 约定

- **维基链接**：正文中写 `[[页面名]]`，提交前调 `fw.resolve_wikilinks()` 转成 `<mention-doc>`
- **首次出现规则**：页面中已有维基页面对应的专有名词，首次出现必须用 `[[维基链接]]`
- **写入默认 append**：避免覆盖。只在完全重建页面时用 `overwrite`
- **日期 ISO 8601**：`2026-04-07`
- **不确定主张**：标注 `[未验证]` 或 `[与 [[来源]] 矛盾]`
- **优先更新现有页面** —— 整合优于分散
- **每个事实主张必须追溯到来源** —— 无来源主张不允许
- **不要添加成熟度标签**（developing / mature 等）
- **所有文档必须明确标注出处** —— 包括从飞书搜索获取的外部文档上下文

## 禁止事项

- **禁止在飞书 UI 直接编辑维基页面** —— 所有修改必须通过 Agent
- **禁止修改 `原始资料/*` 页面** —— 原文归档不可变
- **禁止发表无来源归属的主张**
- **未经用户批准不要删除页面** —— 改为标记 `[已废弃]`
- **不要为只被提及一次的概念创建页面** —— 等第二个来源确认
- **不要过度拆分主题** —— 一个丰富的页面优于三个单薄的存根
- **不要绕过 `feishu_wiki` API** —— 不直接调 `lark-cli`、不手动改 `.cache/`
- **不要绕过写锁** —— 所有写操作必须通过 `fw.update` / `fw.create` 或 `with fw.lock()`
- **不要提交 `.cache/` 到 git**

## 给用户浏览页面

当用户想在飞书中查看某个页面时：

```python
url = fw.link("智能体护栏与约束")
# → "https://bytedance.larkoffice.com/wiki/MQqt..."
```

把 URL 直接给用户，他们可以在浏览器中打开。

## 故障处理

### 写锁卡住

如果锁超过 5 分钟，会自动释放。如果仍有问题：
1. `fw.fetch("队列", fresh=True)` 查看当前队列
2. 确认是否有过期条目
3. 必要时手动清理队列页面

### 缓存疑似损坏

```bash
rm -rf .cache
python3 -c "import feishu_wiki as fw; fw.status()"
```

下次 API 调用会触发索引重建。

### 适配不同 Agent

本文件可直接用于：
- **Claude Code** → 复制为 `CLAUDE.md`
- **OpenAI Codex** → 复制为 `AGENTS.md`
- **Cursor** → 复制为 `.cursorrules`
- **其他 Agent** → 复制到对应的指令文件

核心 API（`import feishu_wiki as fw`）在任何 Python 环境中都可用。
