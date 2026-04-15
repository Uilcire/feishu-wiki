# 存储架构

**飞书是信源。本地只有缓存和代码。**

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

## 缓存模型：lazy cache + on-demand fetch

```
首次启动 → 后台子进程构建索引（页面列表 + summary + edit_time）+ 日志
         → 主进程立即返回，不阻塞用户
         → search 通过云端 token 清单过滤结果（无需等索引）
索引就绪后 →
  读 → 查索引定位 → 按需拉取单个页面 → 本地缓存（edit_time 一致则用缓存）
  写 → 拿锁 → fetch(fresh=True) → 修改 → 立即上传 → 释放锁
```

- **后台索引构建**：首次运行时 `ensureCache()` 生成 `scripts/build-index.js` 子进程（detached），`.cache/.building` 标记构建中
- **索引 TTL = 60 秒**：`find()` / `listPages()` 自动刷新过期索引（索引已存在时同步刷新，快速）
- **页面按需缓存**：`fetch()` 首次调用时拉取，后续用本地缓存（edit_time 变了自动刷新）
- **`fetch(fresh=True)`**：写操作前使用，保证拿到最新版本
- **只缓存 AI Wiki 内的页面**：`searchFeishu()` 返回的外部文档不缓存
- **云端 token 清单**：根页面尾部嵌入 `<!-- wiki-tokens:tok1,tok2,... -->`，`searchFeishu()` 在本地索引未就绪时拉取此清单过滤结果

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
- **批量操作**：使用 `with fw.lock()` 手动管理
- **嵌套安全**：`with fw.lock()` 内部的 `create` / `update` 不会重复拿锁

## 用户契约

**用户不要直接编辑飞书 UI 里的维基页面。**

- 允许：浏览、评论
- 禁止：编辑正文、添加图片/表格/视频、移动或重命名节点

如果非要直接改，先让 Agent `fw.sync()` 确认无 dirty，改完后 `fw.refresh()` 重建缓存。

## QA 追踪（v0.2.7+）

所有读操作（`find`/`fetch`/`grep`/`search_feishu`）和显式 `log_qa()` 调用会异步写入飞书 Base。

```
调用 find("ReAct")
    ↓
_log_qa_event("call:find", "ReAct", "ReAct 架构")
    ↓ (非阻塞)
Queue → daemon worker → lark-cli base +record-upsert → 飞书 Base
```

- **Base**: `CO7nbn23lawW7wsCdYkctJGmnib`（QA History）
- **Table**: `tbl0t8tClxjV4ZIP`（qa_history）
- **Session**: 每个进程启动时生成 UUID，关联同一会话的所有调用
- **开关**: `FEISHU_WIKI_QA_LOG=0` 关闭

### 注意事项

1. **lark-cli 权限**：写入 Base 需要 `base:record:write` scope。如遇 `missing_scope` 错误：
   ```bash
   lark-cli auth login --scope "base:record:write"
   ```
2. **daemon 线程**：worker 是 daemon 线程，进程退出时未 flush 的记录会丢失。`atexit` 会尝试关闭队列，但无法保证所有记录都写入。对于 analytics 数据，这是可接受的。
3. **失败静默**：Base 写入失败不会影响主流程，错误被静默忽略。

## 冲突处理

sync 前重新拉取 dirty 页面的 `obj_edit_time`。若飞书端被改过：

1. 查看冲突页面当前状态
2. 保留飞书版本：删除对应缓存，`fw.refresh()`
3. 保留本地版本：合并飞书新内容到缓存，`fw.sync()`
