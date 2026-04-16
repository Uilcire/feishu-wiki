# Changelog

## 0.6.3 (2026-04-16)

### 重构

- **原子写入**：`saveIndex`/`saveState` 使用 write-tmp-then-rename 模式，防止进程崩溃导致 index.json/state.json 损坏
- **QA 日志异步化**：`_logQaEvent`/`logQa` 改为追加 NDJSON 队列文件（`.cache/qa-events.ndjson`），`flushQaEvents()` 在 `sync`/`refresh` 时批量上传，主读路径零阻塞
- **Stale 模式显式化**：索引刷新失败时标记 `freshness: "stale-fallback"` 并输出 stderr 警告，`status()` 新增 `freshness`、`last_successful_refresh_at`、`last_refresh_failed_at`、`last_refresh_error` 字段
- **`iterPages` 封装**：集中 deprecated/category 过滤逻辑，`find`/`listPages`/`lint`/`_syncContainerPage`/`_syncRootPage` 统一使用，消除散落的 inline 判断

### 测试

- 新增 37 个对抗性测试（`tests/core-refactor.test.js`），覆盖原子写入、QA 队列、stale 模式、iterPages 一致性、边界条件

## 0.6.2 (2026-04-16)

### Bug 修复

- 从 stderr 恢复 lark-cli 的 JSON 错误响应（lark-cli 失败时输出到 stderr，之前只检查 stdout 导致沙箱中错误被静默吞掉）
- 添加 `codex.json` 白名单放开 `open.feishu.cn`、`open.larksuite.com` 出站网络，修复 Codex 沙箱中 lark-cli 网络调用全部失败的问题

## 0.6.1 (2026-04-16)

### 改进

- `AI_WIKI_DEBUG=1` 环境变量开启调试模式：lark-cli 每次调用打印完整输入/输出/错误到 stderr
- lark-cli 调用静默失败时输出诊断日志，帮助排查 Codex 沙箱 EPERM 等问题

## 0.6.0 (2026-04-16)

### 性能优化

- **lint 性能大幅提升**：每个页面只 fetch 一次（原来最多 4 次），页面查找从 O(n²) 降到 O(n)
- **模块级索引内存缓存**：`find`/`listPages`/`exists` 连续调用不再重复解析 JSON
- **模块级配置缓存**：`.feishu-config.json` 只读一次，后续直接复用
- **fetch() 状态优化**：state 文件从 2 次加载合并为 1 次
- **锁轮询优化**：忙等待改为 `Atomics.wait`（CPU 0%），无过期条目时不写回队列
- **lark.js 限流退避**：忙等待改为 `Atomics.wait`
- **搜索 token 缓存**：wiki token 集合会话内只构建一次
- **fetch 命令去重**：消除 `find` + `fetch` 双重索引查找
- **state/index 精简序列化**：去掉 JSON pretty-print，减少 IO
- 清理死代码 `markDirtyLog()`

## 0.5.9 (2026-04-16)

### 改进

- SKILL.md 添加自动升级指令：Agent 看到"新版本可用"时必须立即升级

## 0.5.8 (2026-04-16)

### Bug 修复

- `create` 和 `update` 写入前自动调用 `resolveWikilinks()`，将 `[[页面名]]` 转为飞书 `<mention-doc>` 格式
- `lint` 新增"未解析链接"检查：检测页面中残留的 `[[]]` 格式链接

## 0.5.7 (2026-04-16)

### Bug 修复

- 修复 Codex 沙箱中 `lark-cli` 调用全部静默失败的问题：沙箱给 `spawnSync` 加 `EPERM` 错误，即使命令实际成功（exit 0 + 有效 stdout）。`run()` 现在在捕获异常时检查 `err.stdout` 是否包含有效 JSON，有则正常返回

## 0.5.6 (2026-04-16)

### 改进

- SKILL.md 新增沙箱环境说明（PATH 设置 + `ai-wiki setup`）
- `agents/openai.yaml`、`agents/claude.yaml` 添加 `env.ensure_path`，Agent 自动处理 PATH

## 0.5.5 (2026-04-16)

### 改进

- `lark-cli` 路径自动探测：依次检查 `LARK_CLI_PATH` 环境变量 → PATH 目录扫描 → 常见安装路径（`/opt/homebrew/bin`、`~/.npm-global/bin`、nvm 路径），解决 Agent 沙箱或不同 shell 环境下找不到 `lark-cli` 的问题
- `setup` 命令使用探测到的绝对路径执行 `auth login`

## 0.5.4 (2026-04-15)

_0.5.3 版本号已被占用，内容与 0.5.3 相同。_

## 0.5.3 (2026-04-15)

### 改进

- 首次索引构建改为同步执行，`list`/`find` 等命令不再返回空结果
- 索引构建过程实时报告进度：每扫描完一个容器即输出页面数和累计总数
- 移除后台构建时的空壳降级逻辑（不再返回 `{ pages: {} }` 假装成功）

### Bug 修复

- `upgrade` 命令包名修正：`ai-wiki` → `@uilcire/ai-wiki`（版本检查、安装、手动提示三处）
- `agents/claude.yaml`、`agents/openai.yaml` 更新：移除旧 `feishu-wiki` 引用和 Python 残留，统一为 `ai-wiki` CLI

## 0.5.2 (2026-04-15)

### Bug 修复

- 版本检查包名修正：`npm view ai-wiki` → `npm view @uilcire/ai-wiki`，不再误报别人的包为新版本

## 0.5.1 (2026-04-15)

### Bug 修复

- 索引 TTL 过期重建失败时回退到旧缓存，不再直接崩溃
- 修正默认配置文件查找路径（`skills/default-config.json` → `default-config.json`），修复无 `.feishu-config.json` 时索引重建必然失败的问题
- `default-config.json` 补全 `root_obj_token`，避免额外 API 调用

## 0.5.0 (2026-04-15)

### 重构：Python → Node.js

- 整体从 Python 包迁移到 Node.js（CommonJS，Node 16+）
- CLI 入口：`ai-wiki`（npm 全局安装）
- 包名：`ai-wiki`（原 `feishu-wiki`）

### 新功能

- 后台索引构建：首次运行不再阻塞，索引在后台子进程构建
- 云端 token 清单：根页面嵌入 `<!-- wiki-tokens:... -->`，`search` 在索引未就绪时直接从云端获取 token 集合过滤结果
- `ai-wiki status` 新增 `building` 和 `corrupted` 状态
- `ai-wiki setup` 一键安装（检测 lark-cli + 登录 + 验证连接）

### Bug 修复

- `loadIndex()` / `loadState()` 加 try/catch，损坏的缓存文件不再崩溃
- `log-qa` 非法 JSON 输入不再抛出原始 SyntaxError
- `mode <非法值>` 退出码从 0 改为 1
- `find` 无结果时输出错误到 stderr（不再输出 `null` 到 stdout）

### 测试

- 新增 193 个单元测试（`node:test` + `node:assert`，零依赖）
- 覆盖：core、commands、lark、lock、search、postinstall、integration、docs/structure

## 0.4.0 (2026-04-15)

- Node.js 重写：从 Python 迁移到 Node.js CommonJS
- npm postinstall 自动注册 skill 到 ~/.agents、~/.claude、~/.codex
- 旧 `feishu-wiki` skill 目录自动清理

## 0.3.0 (2026-04-15)

- lark-cli 包名修正为 `@larksuite/cli`
- `feishu-wiki update` 强制跳过版本缓存，立即检查 PyPI 最新版

## 0.2.9 (2026-04-14)

- 包内打包 `default-config.json`，新用户无需手动创建 `.feishu-config.json`
- 简化安装流程：只需 `pip install feishu-wiki`
- onboarding + README 补充 QA 追踪说明

## 0.2.8 (2026-04-14)

- `log_qa()` 增加 `tools` 参数：记录完整工具链路（name/input/output/error）
- Base 新增 `tools_trace`、`has_error`、`error_detail` 字段

## 0.2.7 (2026-04-14)

- QA 追踪：`find`/`fetch`/`grep`/`search_feishu` 自动埋点到飞书 Base
- 新增 `fw.log_qa(question, answer)` 供 agent 记录完整 QA 交互
- 后台线程异步写入，不阻塞主流程
- 环境变量 `FEISHU_WIKI_QA_LOG=0` 可关闭

## 0.2.6 (2026-04-14)

- 容器页自动同步：`create()`/`delete()` 后自动更新分类容器页面（子页面列表+计数）
- AI Wiki 根页面自动同步：容器变更后重新生成全局导航
- `_build_index` 通过 `get_node` API 补全 root `obj_token`
- `lint()` 新增「容器失同步」检查项

## 0.2.5 (2026-04-14)

- `fw.lint()` 交叉引用审查：断链、孤立页面、来源缺归档、索引缺页
- 收录规范强化

## 0.2.4 (2026-04-14)

- 日志署名用飞书 mention-user 标签

## 0.2.3 (2026-04-14)

- `compact_log` 保留已有周汇总 + 日志署名加 @

## 0.2.2 (2026-04-14)

- 日志格式优化 + `compact_log()` 压缩旧日志

## 0.2.1 (2026-04-14)

- `fw.delete()` 软删除 — 标记已废弃 + 索引过滤

## 0.2.0 (2026-04-14)

- Agent Skills 标准化 — `src/` layout + 完整 skill 分发
- 完整 CLI 子命令 + skill manifest + 项目级 SKILL.md

## 0.1.6 (2026-04-14)

- setup 时自动检查并申请 `base:app:create` scope，反馈功能开箱即用

## 0.1.5 (2026-04-14)

- 新增 `fw.feedback()` —— 提交反馈到飞书多维表格，自动附带提交人、版本号、时间戳
- 新增 CLI 命令 `feedback`：`python3 -m feishu_wiki feedback "内容"`
- `fw.status()` 返回 `update_available` 字段，Agent 可感知新版本并提醒用户

## 0.1.4 (2026-04-14)

- 新增 `_version_check.py` —— 对比 PyPI 最新版，24h 缓存，2s 超时
- 新增 CLI 命令 `update`：`python3 -m feishu_wiki update` 一键升级

## 0.1.3 (2026-04-13)

- 新增 `__main__.py` —— 支持 `python3 -m feishu_wiki`，不依赖 PATH
- README 安装指引更新为 `python3 -m feishu_wiki register`

## 0.1.2 (2026-04-13)

- 学习/贡献模式切换：`feishu-wiki mode read` / `feishu-wiki mode write`

## 0.1.1 (2026-04-12)

- 改进 onboarding 介绍
- 精简 README

## 0.1.0 (2026-04-12)

- 初始发布
- `feishu-wiki-register` 一键注册 Claude Code / Codex skill
- 核心 API：`fw.find`、`fw.fetch`、`fw.create`、`fw.update`、`fw.list_pages`
- 本地缓存工作拷贝模型（checkout → edit → checkin）
- 维基链接解析 `[[页面名]]` → `<mention-doc>`
- 自动 attribution callout
- 全文搜索：`fw.grep`（本地）、`fw.search_feishu`（飞书 API）
