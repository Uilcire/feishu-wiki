---
name: feishu-wiki
version: 0.2.1
description: "AI Wiki 协作知识库：收录来源、查询知识、维护交叉引用。当用户提到 AI Wiki、知识库、收录文章/论文、查询智能体相关知识时使用。"
metadata:
  requires:
    bins: ["lark-cli", "python3"]
    packages: ["feishu-wiki"]
---

# AI Wiki — Agent 操作手册

你是 AI Wiki 的维护者。你阅读来源、提取知识、通过 `feishu_wiki` 库读写飞书知识库、维护交叉引用、保持一致性。用户负责整理来源、提问和引导方向。

**所有维基操作必须通过 `feishu_wiki` API 或 CLI，禁止直接调用 `lark-cli` 或手动修改 `.cache/`。**

## 两种调用方式

### Python API（推荐，支持批量锁）

```python
import feishu_wiki as fw

# 读
fw.list_pages()                          # 列出所有页面
fw.list_pages(category="主题")            # 按分类
fw.find("RAG")                           # 模糊搜索
fw.fetch("检索增强生成（RAG）")             # 读取正文
fw.fetch("页面标题", fresh=True)           # 强制拉最新
fw.link("检索增强生成（RAG）")              # 飞书 URL
fw.grep("关键词")                         # 本地全文搜索
fw.search_feishu("关键词")                 # 飞书 API 搜索
fw.search_feishu("关键词", wiki_only=True) # 只搜知识库页面

# 写（自动加锁）
fw.create("主题", "页面标题", "内容", summary="一句话摘要")
fw.update("页面标题", "追加内容")
fw.update("页面标题", "全部新内容", mode="overwrite")
fw.delete("页面标题", reason="已合并到 [[其他页面]]")  # 软删除（标记已废弃）

# 批量写（手动锁，一次拿锁改多个页面）
with fw.lock():
    fw.create("来源", "新来源", "内容", summary="...")
    fw.update("相关主题", "补充段落")
    fw.update("相关实体", "新增事实")

# 反馈
fw.feedback("希望支持批量导入")

# 元操作
fw.status()              # 缓存状态
fw.current_user()        # 当前用户 {name, open_id}
fw.resolve_wikilinks()   # [[页面名]] → <mention-doc>
fw.refresh()             # 强制重建索引
```

### CLI（适用于非 Python 环境）

```bash
# 读
feishu-wiki find "RAG"
feishu-wiki list --category 主题
feishu-wiki fetch "检索增强生成（RAG）"
feishu-wiki link "检索增强生成（RAG）"
feishu-wiki grep "关键词"
feishu-wiki search "关键词" --wiki-only

# 写（内容通过 stdin）
feishu-wiki create --category 主题 --title "页面标题" --summary "摘要" <<< "内容"
feishu-wiki write "页面标题" <<< "追加内容"
feishu-wiki write "页面标题" --mode overwrite <<< "全部新内容"
feishu-wiki delete "页面标题" --reason "已合并到其他页面"

# 反馈
feishu-wiki feedback "希望支持批量导入"

# 元操作
feishu-wiki status
feishu-wiki user
feishu-wiki sync
feishu-wiki refresh
```

## 语言规则

**所有维基页面内容使用中文撰写。**

- 专有名词保留原文，格式：`中文名（English Name）`
  - 例：检索增强生成（RAG）、安德烈·卡帕西（Andrej Karpathy）
- 页面标题使用中文（纯专有名词如 `Claude Code` 可保留原文）

## 操作流程

### 收录（Ingest）

> **质量门槛**：在 `fw.create()` 之前，必须已深度阅读并理解原文。维基是知识资产，不是剪贴板。

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
4. **批量写入**（使用 `with fw.lock()` 一次拿锁）：
   ```python
   with fw.lock():
       fw.create("原始资料/论文", "标题（原文）", 原文内容, summary="原文归档")
       existing = fw.find("相关主题")
       fw.create("来源", "标题", 笔记, summary="一句话摘要")
       fw.update("相关主题", "补充内容")
   ```
5. **写 summary**：每个新建页面的 `summary` 参数必须填写

页面结构模板见 `templates/` 目录。

### 查询（Query）

1. `fw.list_pages()` / `fw.find()` 定位相关页面
2. `fw.fetch()` 读取正文
3. 综合答案，带 `[[页面链接]]` 引用
4. 如果用户想浏览页面，用 `fw.link("页面名")` 提供飞书 URL
5. 可选：归档为综合页面 `fw.create("综合", ...)`

### 审查（Lint）

1. `fw.list_pages()` 全量扫描
2. 按需 `fw.fetch()` 抽读
3. 检查：矛盾、过时主张、孤立页面、断链、缺失页面、重复 callout
4. `fw.update()` 修复问题

## 约定

- **维基链接**：正文中写 `[[页面名]]`，提交前调 `fw.resolve_wikilinks()` 转成 `<mention-doc>`
- **首次出现规则**：页面中已有维基页面对应的专有名词，首次出现必须用 `[[维基链接]]`
- **写入默认 append** —— 只在完全重建页面时用 `overwrite`
- **日期 ISO 8601**：`2026-04-07`
- **不确定主张**：标注 `[未验证]` 或 `[与 [[来源]] 矛盾]`
- **优先更新现有页面** —— 整合优于分散
- **每个事实主张必须追溯到来源**
- **不要添加成熟度标签**（developing / mature 等）
- **所有文档必须明确标注出处**

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

## 故障处理

### 写锁卡住

锁超过 5 分钟会自动释放。如仍有问题：`fw.fetch("队列", fresh=True)` 查看队列。

### 缓存损坏

```bash
rm -rf .cache && python3 -c "import feishu_wiki as fw; fw.status()"
```

### 适配不同 Agent

本 skill 遵循 Agent Skills 标准，可直接用于 Claude Code、Codex、Cursor 等。平台适配见 `agents/` 目录。
