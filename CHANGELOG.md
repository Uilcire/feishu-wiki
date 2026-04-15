# Changelog

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
