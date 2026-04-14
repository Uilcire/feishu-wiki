---
name: feishu-wiki
version: 0.1.7
description: "AI Wiki 协作知识库：收录来源、查询知识、维护交叉引用。当用户提到 AI Wiki、知识库、收录文章/论文、查询智能体相关知识时使用。"
metadata:
  requires:
    bins: ["lark-cli", "python3"]
---

<!-- 本文件从 AGENTS.md 精简而来，保留 Agent 操作所需的核心 API 参考 -->
<!-- 完整文档见仓库根目录 AGENTS.md -->

# AI Wiki — Agent 操作手册

你是 AI Wiki 的维护者。所有维基操作必须通过 `feishu_wiki` API 或 CLI，禁止直接调用 `lark-cli`。

## 两种调用方式

### Python API（推荐，支持批量锁）

```python
import feishu_wiki as fw

# 读
fw.list_pages()                          # 列出所有页面
fw.list_pages(category="主题")            # 按分类
fw.find("RAG")                           # 模糊搜索
fw.fetch("检索增强生成（RAG）")             # 读取正文
fw.link("检索增强生成（RAG）")              # 飞书 URL
fw.grep("关键词")                         # 本地全文搜索
fw.search_feishu("关键词")                 # 飞书 API 搜索

# 写
fw.create("主题", "页面标题", "内容", summary="摘要")
fw.update("页面标题", "追加内容")
fw.update("页面标题", "新内容", mode="overwrite")

# 批量写
with fw.lock():
    fw.create("来源", "新来源", "内容", summary="...")
    fw.update("相关主题", "补充段落")

# 反馈
fw.feedback("希望支持批量导入")

# 元操作
fw.status()              # 缓存状态
fw.current_user()        # 当前用户
fw.refresh()             # 重建索引
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

# 反馈
feishu-wiki feedback "希望支持批量导入"

# 元操作
feishu-wiki status
feishu-wiki user
feishu-wiki sync
feishu-wiki refresh
```

## 关键规则

- **写入默认 append**，只在完全重建时用 overwrite
- **所有页面用中文**，专有名词格式：`中文名（English Name）`
- **维基链接**：正文写 `[[页面名]]`，提交前调 `fw.resolve_wikilinks()`
- **禁止修改 `原始资料/*`**（不可变归档）
- **禁止在飞书 UI 直接编辑**
- **不要为只出现一次的概念建页面**

完整操作流程、页面结构模板、故障处理见 `AGENTS.md`。
