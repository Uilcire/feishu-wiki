# AI Wiki — Project Context

> 供外部审阅者快速了解系统设计与实施方式。读完本文档应能对架构、数据流、并发模型、缓存策略、Agent 协作契约做出有依据的技术判断。

---

## 1. 它是什么

AI Wiki 是一个 **CLI 工具**（`ai-wiki`），供 AI Agent（Claude Code、Codex 等）调用，在飞书知识库上维护一个协作知识库。

核心约束：
- **零依赖**。纯 CommonJS，目标 Node.js 16+，`npm install` 后即可用。
- **所有飞书 API 访问走 `lark-cli` 子进程**，不直接发 HTTP。CLI 是无状态包装器，每次调用一个 `execFileSync`。
- **Agent 只能通过 CLI 操作知识库**。不直接改 `.cache/`，不直接调 `lark-cli`，不通过飞书 UI 编辑内容。

---

## 2. 数据模型

知识库是一棵固定结构的飞书 wiki 树：

```
AI Wiki (root)
├── 来源/          ← 信息来源页（论文解读、文章摘要等）
├── 主题/          ← 主题聚合页（RAG、RLHF 等概念）
├── 实体/          ← 实体页（GPT-4、DeepSeek 等具体事物）
├── 综合/          ← 综合分析页（跨主题交叉引用）
├── 原始资料/      ← 不可变存档（全文保存，创建后禁止修改）
│   ├── 论文/
│   ├── 文章/
│   ├── 书籍/
│   └── wiki/
├── 日志           ← 操作日志（自动维护）
└── 队列           ← 分布式写锁（FIFO 队列页）
```

**交叉引用规则**：
- 每个「来源」必须关联至少一个「原始资料」和至少一个「主题」或「实体」
- 「主题」/「实体」页底部列出所有引用它的「来源」
- 引用语法：写入时 `[[页面名]]`，CLI 自动解析为飞书 `<mention-doc>` 标签

---

## 3. 缓存架构：Lazy Sync + On-Demand Fetch

不做全量同步。原因：知识库可能有上千页，但一次会话通常只涉及 5-10 页。

### 三层缓存

| 层级 | 存储位置 | 内容 | 失效策略 |
|------|---------|------|---------|
| 内存 | 进程变量 | 解析后的 index、config、token 集合 | 进程结束即失效 |
| 磁盘 | `.cache/` | `index.json`（页面元数据）、`docs/*.md`（页面内容）、`state.json`（状态） | Index: 60s TTL（mtime 检查）；Page: `obj_edit_time` 比对 |
| 远端 | 飞书 API | 权威数据源 | 用户在飞书 UI 直接编辑时不会通知 CLI |

### 索引构建

**首次运行**：`ensureCache()` 检测到无 `.cache/`，spawn 一个 `build-index.js` 作为 detached 子进程在后台构建。主进程不阻塞，直接返回空结果或 `{"cache":"building"}`。

**后续运行**：检查 `index.json` mtime，超过 60s 则同步重建（第二次构建很快，因为只是 re-list children）。重建失败时回退到 stale 缓存，标记 `freshness: "stale-fallback"`。

**显式刷新**：`ai-wiki refresh` 强制同步重建。

### 页面内容缓存

只在 `fetch()` 时按需拉取。缓存键是 `obj_edit_time`（飞书返回的最后编辑时间戳）。命中则读本地 `.cache/docs/{title}.md`（~10ms），未命中则调 lark-cli 拉取（500-1000ms）。

**写入前总是 `fetch(fresh=true)`**，绕过缓存拿最新版本，避免覆盖他人修改。

---

## 4. 读路径

```
Agent 调用 CLI 命令（find / fetch / search / list / grep）
  │
  ├─ find(query)
  │    检查索引 → 精确匹配（O(1)） → 模糊匹配（title contains，按长度排序）
  │    返回 {title, category, node_token, obj_token, url, summary}
  │
  ├─ fetch(title, {fresh?})
  │    find() 定位 → 检查缓存 edit_time → 命中返回本地 / 未命中调 lark-cli
  │    返回完整 markdown 内容
  │
  ├─ search(query, {allDocs?})
  │    调飞书搜索 API → 用 wiki token 集合过滤结果（只返回本知识库页面）
  │    token 集合来源：index 有则用 index，index 未就绪则从 root 页面的
  │    <!-- wiki-tokens:... --> 注释中提取（保证搜索在索引构建期间也能用）
  │
  └─ grep(pattern, {category?})
       正则搜索本地已缓存的页面（只搜 .cache/docs/*.md）
       返回匹配页面 + 行号，按命中数排序
```

**典型延迟**：索引命中 + 页面缓存命中 ≈ 50ms。索引重建 ≈ 1-2s。页面缓存未命中 ≈ 500ms-1s。

---

## 5. 写路径

```
Agent 调用写命令（create / update / delete）
  │
  ▼
① 权限检查
   读 ~/.feishu-wiki-config.json → write_enabled === true?
   否 → 报错退出（exit 1），不获取锁
  │
  ▼
② 获取分布式写锁
   读「队列」页面 → 清理超时条目（>5min） → 追加自己到队尾 → 轮询（15s）直到自己在队首
   使用 Atomics.wait() 做零 CPU 占用的 sleep
   进程内 _lockHeld 标志防止嵌套获取
  │
  ▼
③ 拉取最新版本
   fetch(title, fresh=true) → 绕过缓存，确保拿到飞书上的最新内容
  │
  ▼
④ 内容处理
   a. 解析 wikilinks: [[页面名]] → <mention-doc token="..." type="docx">页面名</mention-doc>
      找不到目标页面时降级为加粗文本 **页面名**
   b. 插入/更新归属标注（创建人、创建日期、最后更新人、最后更新日期）
   c. 拼接内容（append 模式：旧内容 + 新内容；overwrite 模式：替换全部）
  │
  ▼
⑤ 上传
   lark docs +update --doc objToken --mode overwrite --markdown content
  │
  ▼
⑥ 更新本地缓存
   原子写入 .cache/docs/{title}.md 和 index.json（write-tmp-then-rename）
  │
  ▼
⑦ 同步导航页
   更新所属分类的容器页面（ASCII 目录树 + mention-doc 链接）
   更新 root 页面（全局导航 + wiki-tokens 列表）
  │
  ▼
⑧ 释放写锁
   从「队列」页移除自己
  │
  ▼
⑨ 追加操作日志
   写入 .cache/日志.md（本地） + 追加 QA 事件到 NDJSON 队列
```

---

## 6. 并发模型

**场景**：多个 Agent 实例（不同用户或同一用户的多个会话）可能同时操作同一知识库。

**方案**：基于飞书 Wiki 页面的分布式 FIFO 锁。

```
「队列」页面内容格式：
# 写入队列

alice|2026-04-16T10:05:00Z
bob|2026-04-16T10:05:30Z
```

- **队首** = 持锁者，其他人按 FIFO 顺序等待
- **轮询间隔**：15s（`Atomics.wait()`，不是 busy-wait）
- **超时清理**：>300s 的条目自动移除，防死锁
- **锁粒度**：全局（整个知识库一把锁，不是页面级）
- **嵌套保护**：进程内 `_lockHeld` 标志，同一进程不会重复获取

**为什么不用页面级锁**：知识库写操作涉及多页联动（内容页 + 容器页 + root 页 + 日志页），页面级锁会导致复杂的锁排序问题。全局锁在当前并发度（1-3 个 Agent 偶尔写入）下完全够用。

**读写隔离**：读操作不需要锁。写操作在锁内先 `fetch(fresh=true)` 拿最新版本再修改，保证不覆盖他人修改。

---

## 7. 错误处理哲学

**原则：读路径绝不阻塞，写路径快速失败，遥测允许丢失。**

| 场景 | 处理方式 |
|------|---------|
| 索引构建失败 | 回退到 stale 缓存 + 标记 `freshness: "stale-fallback"` |
| lark-cli 超时 | `fetchDocMarkdown` 重试 3 次，指数退避（1.5s × attempt） |
| 沙箱 EPERM（Codex 环境） | 从 stderr 恢复 JSON 输出（lark-cli 的 stdout 可能被沙箱吞掉） |
| QA 日志上传失败 | 静默丢弃，不影响主路径 |
| 写锁超时 | 自动清理 stale 条目，不需要人工干预 |
| 权限不足 | 检查在获取锁之前，快速失败（避免占锁后才发现不能写） |
| wikilink 目标不存在 | 降级为加粗文本 `**页面名**`，不阻断写入 |

---

## 8. CLI ↔ Agent 契约

### 输入

```bash
ai-wiki <command> [args] [--flags] [<<< stdin_content]
```

### 输出

- **成功**：JSON 到 stdout，exit 0
- **失败**：错误信息到 stderr，exit 1
- **诊断信息**：始终到 stderr（以 `[fw]` 前缀），不污染 stdout 的 JSON

### 关键命令签名

```bash
# 读
ai-wiki find <query> [--category CAT]              → {title, category, match_type, ambiguity_count, top_candidates, freshness, data_source, ...}
ai-wiki fetch <title> [--fresh]                     → markdown string (stdout) + stderr: freshness/data_source
ai-wiki fetch <title> --head                        → {title, category, summary, sections, freshness, data_source, ...}
ai-wiki fetch <title> --section "名称"              → markdown substring (匹配的 H2 章节)
ai-wiki fetch <title> --excerpt "关键词" [--window N] → 关键词上下文（带行号）
ai-wiki list [--category CAT]                       → {results: [...], freshness, data_source}
ai-wiki search <query> [--all-docs]                 → {results: [...], freshness, data_source, token_source}
ai-wiki grep <pattern> [--category CAT]             → {results: [...], coverage: {cached_docs_scanned, total_pages_indexed, coverage_ratio}}

# 写（需要 write_enabled=true + 自动获取写锁）
ai-wiki create --category C --title T [--summary S] [--force] <<< content   # 重名默认拒绝
ai-wiki update <title> [--mode append|overwrite] [--force]     <<< content   # 原始资料默认拒绝
ai-wiki delete <title> [--reason R] [--force]                                # 原始资料默认拒绝

# 管理
ai-wiki status                                      → {cache, mode, user, pages_count, ...}
ai-wiki mode [read|write]                           → 切换读写模式
ai-wiki lint                                        → {ok, stats, issues: [...]}
ai-wiki lint --title <title>                        → {ok, title, checks: {...}} (单页验证)
ai-wiki verify-write <title>                        → {ok, title, checks: {...}} (同上)
ai-wiki refresh                                     → 强制重建索引
ai-wiki sync                                        → 同步日志 + flush QA 事件
```

### Agent 行为约束（SKILL.md 定义）

Agent 被要求遵守以下操作规范：

1. **写前必查**：`find` / `search` 确认目标页面是否已存在，避免重复创建
2. **读后再写**：`fetch` 获取当前内容后再决定 append 还是 overwrite
3. **交叉引用完整性**：创建「来源」页时必须同时关联「原始资料」和至少一个「主题」/「实体」
4. **写后验证**：`lint` 检查链接完整性、孤页、未解析 wikilink
5. **原始资料不可变**：`原始资料/*` 页面创建后禁止修改

这些约束通过 SKILL.md（Agent 的操作手册）软性控制，而非代码强制。唯一的代码级硬约束是 `write_enabled` 开关。

---

## 9. QA 日志系统

**用途**：追踪 Agent 对知识库的操作行为，用于离线分析。

**架构**：本地 NDJSON 队列 → 批量上传到飞书多维表格。

```
Agent 调用 CLI
  ↓
_logQaEvent(eventType, input, outputSummary)
  ↓ (同步追加，<1ms)
.cache/qa-events.ndjson
  ↓ (在 sync/refresh 时批量 flush)
飞书 Base 表格
```

**记录的字段**：
```json
{
  "session_id": "uuid",              // 同一进程的所有调用共享
  "sequence_number": 1,              // 会话内自增，支持离线调用序列重建
  "user_name": "alice",
  "event_type": "call:find",         // call:find / call:fetch / call:fetchHead / denied:write / ...
  "input": "RAG",                    // 调用参数（截断到 2000 字符）
  "output_summary": "检索增强生成（RAG）",
  "latency_ms": 42,                  // 操作耗时
  "payload_size_bytes": 1234,        // 返回内容大小（含多字节字符）
  "outcome": "success",              // success / partial / not_found / denied / cached / error
  "error_type": null,                // not_found / permission_denied / lark_api_error / validation_error
  "timestamp": 1713254400000,
  "version": "0.7.0"
}
```

**当前局限**：
- CLI 侧能记录调用事实和结果类型，但 agent 侧的意图（goal / next_action）需要通过未来的 `--trace-meta` 参数传入

---

## 10. 验证系统

### 全量 Lint（`ai-wiki lint`）

| 检查项 | 说明 |
|--------|------|
| 断裂链接 | 页面内 `[[...]]` 或 `<mention-doc>` 指向不存在的页面 |
| 孤页 | 零入链的页面（没有被任何其他页面引用） |
| 来源完整性 | 来源页必须引用「原始资料」AND（「主题」OR「实体」） |
| 未解析 wikilink | 内容中残留的 `[[...]]` 文本（应该在写入时被解析） |
| 主题/实体覆盖度 | 每个主题/实体至少被一个来源引用 |

**性能优化**：每页只 fetch 一次，Map 查找 O(1)，入链计算 O(n)。

### 单页验证（`ai-wiki verify-write <title>` 或 `lint --title <title>`）

写入后快速验证单页质量，不需要跑全量 lint：

| 检查项 | 说明 |
|--------|------|
| page_exists | 页面是否存在于索引 |
| content_nonempty | 内容是否非空 |
| unresolved_wikilinks | 残留的 `[[...]]` 未解析链接 |
| broken_mentions | `<mention-doc>` token 不在索引中 |
| has_attribution | 是否有归属标注 callout |

---

## 11. 设计决策及其理由

### 为什么零依赖？

CLI 需要被 `npm install -g` 快速安装到各种环境（本地、CI、Codex 沙箱）。零依赖意味着安装时间 < 2s，不存在版本冲突。所有功能用 Node.js 标准库实现。

### 为什么走 lark-cli 子进程而不是直接调 HTTP API？

1. lark-cli 管理 OAuth token 刷新、分页、限流重试 — CLI 不需要重新实现
2. 子进程天然隔离，一次 API 调用的内存泄漏不影响主进程
3. 可以在不改 ai-wiki 代码的情况下升级飞书 API 版本

### 为什么 wikilink 在写入时解析而不是渲染时？

1. `<mention-doc>` 是飞书原生标签，渲染为可点击链接，比自定义 markdown 语法体验更好
2. 解析时机早 = 能在写入时就发现目标不存在（降级为加粗文本 + lint 报告）
3. 一旦解析为 token，链接不受页面重命名影响

### 为什么软删除而不是硬删除？

知识库内容有交叉引用。硬删除会产生大量断裂链接。软删除（prepend deprecation callout + 标记 `deprecated: true`）保留内容可访问性，同时从 `list` 和 `find` 的默认结果中隐藏。

### 为什么 QA 日志用 NDJSON 队列而不是直接写远端？

1. 主读路径延迟敏感（50ms 级），不能为遥测多一次 API 调用
2. 飞书 Base API 偶尔超时，不能让写入失败阻断主路径
3. 批量 flush 效率更高（50 条 → 几次 API 调用，而非 50 次）
4. 进程崩溃最多丢失一批未 flush 的事件，对遥测可接受

---

## 12. 当前局限（已知的，不是 bug）

1. **全局锁粒度粗**：在并发度从 1-3 升到 10+ 时会成为瓶颈。当前场景不需要优化。
2. **飞书 UI 直接编辑不会通知 CLI**：用户如果在飞书 UI 改了内容，CLI 的缓存可能过期。需要 `ai-wiki refresh` 手动刷新。
3. **QA 日志缺少 agent 侧语义**：CLI 现在记录 outcome/latency/payload，但 agent 的意图（goal / next_action / sufficient_for_next_step）需要通过未来的 `--trace-meta` 参数传入。
4. **权限控制只有一层**：`write_enabled` 是全有或全无的开关，没有细粒度权限（如"只允许 append 不允许 overwrite"）。
5. **搜索依赖本地缓存**：`grep` 只搜已 fetch 过的页面，不是全量搜索。`grep` 现在返回 `coverage_ratio` 提醒 agent 覆盖不足时改用 `search`。
