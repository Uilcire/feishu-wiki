/**
 * core.js — 索引、缓存、读写、QA 日志
 *
 * 架构模型：lazy cache + on-demand fetch
 *   - 启动时：只拉索引（页面列表 + summary + edit_time）和日志
 *   - 读：先查索引定位，按需拉取单个页面（本地缓存 + TTL）
 *   - 写：acquire lock → fetch fresh → modify → upload → release lock
 *   - 索引 TTL = 60s，过期自动刷新
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const lark = require("./lark");

// === 常量 ===

const CACHE_DIR = path.resolve(".cache");
const BUILDING_FILE = path.join(CACHE_DIR, ".building");
const INDEX_FILE = path.join(CACHE_DIR, "index.json");
const STATE_FILE = path.join(CACHE_DIR, "state.json");
const LOG_FILE = path.join(CACHE_DIR, "日志.md");
const DOCS_DIR = path.join(CACHE_DIR, "docs");
const QA_QUEUE_FILE = path.join(CACHE_DIR, "qa-events.ndjson");

const DEFAULT_SPACE_ID = "7612481259192781765";
const TOP_CONTAINERS = ["来源", "主题", "实体", "综合", "原始资料"];
const RAW_SUBS = ["论文", "文章", "书籍", "wiki"];
const SPECIAL_DOCS = ["日志"];
const ALL_CATEGORIES = [
  ...TOP_CONTAINERS,
  ...RAW_SUBS.map((s) => `原始资料/${s}`),
];

const INDEX_TTL = 60; // seconds

// === 会话级状态 ===

let _cacheReady = false;
let _indexLastRefresh = 0;
let _cachedIndex = null; // 内存缓存已解析的索引，避免重复 JSON.parse

// === QA 追踪 ===

const QA_BASE_TOKEN = "CO7nbn23lawW7wsCdYkctJGmnib";
const QA_TABLE_ID = "tbl0t8tClxjV4ZIP";
const QA_LOG_ENABLED = process.env.FEISHU_WIKI_QA_LOG !== "0";
const QA_SESSION_ID = crypto.randomUUID();

function _logQaEvent(eventType, input, outputSummary) {
  if (!QA_LOG_ENABLED) return;
  const user = lark.currentUser();
  const entry = {
    session_id: QA_SESSION_ID,
    user_name: user.name,
    user_open_id: user.open_id,
    event_type: eventType,
    input: (input || "").slice(0, 2000),
    output_summary: (outputSummary || "").slice(0, 2000),
    timestamp: Date.now(),
    version: VERSION,
  };
  try {
    mkdirp(CACHE_DIR);
    fs.appendFileSync(QA_QUEUE_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // best-effort — never block main path
  }
}

function flushQaEvents() {
  if (!QA_LOG_ENABLED) return { flushed: 0 };
  if (!fs.existsSync(QA_QUEUE_FILE)) return { flushed: 0 };

  let lines;
  try {
    lines = fs.readFileSync(QA_QUEUE_FILE, "utf-8").split("\n").filter(Boolean);
  } catch {
    return { flushed: 0 };
  }
  if (!lines.length) return { flushed: 0 };

  // Rename to processing file to avoid losing data on partial failure
  const processingFile = QA_QUEUE_FILE + ".processing";
  try {
    fs.renameSync(QA_QUEUE_FILE, processingFile);
  } catch {
    return { flushed: 0 };
  }

  let flushed = 0;
  const failed = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      lark.run(
        [
          "base", "+record-upsert",
          "--base-token", QA_BASE_TOKEN,
          "--table-id", QA_TABLE_ID,
          "--json", JSON.stringify(entry),
        ],
        { timeout: 15000 }
      );
      flushed++;
    } catch {
      failed.push(line);
    }
  }

  // Write back failed entries to main queue
  if (failed.length) {
    try {
      fs.appendFileSync(QA_QUEUE_FILE, failed.join("\n") + "\n", "utf-8");
    } catch { /* lost — acceptable for telemetry */ }
  }

  // Clean up processing file
  try { fs.unlinkSync(processingFile); } catch { /* ignore */ }

  if (flushed) {
    process.stderr.write(`[fw] QA 日志已上传 ${flushed} 条\n`);
  }
  return { flushed };
}

const VERSION = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// === 配置缓存 ===

let _configCache = undefined; // undefined = 未加载, null = 无配置

function _loadConfig() {
  if (_configCache !== undefined) return _configCache;
  let configPath = ".feishu-config.json";
  if (!fs.existsSync(configPath)) {
    const defaultCfg = path.join(__dirname, "..", "default-config.json");
    if (fs.existsSync(defaultCfg)) configPath = defaultCfg;
    else configPath = null;
  }
  if (configPath && fs.existsSync(configPath)) {
    try {
      _configCache = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return _configCache;
    } catch { /* ignore */ }
  }
  _configCache = null;
  return null;
}

// === 文件工具 ===

function safeFilename(title) {
  return title.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function docCachePath(title) {
  return path.join(DOCS_DIR, `${safeFilename(title)}.md`);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const temp = path.join(dir, `.${base}.${process.pid}.tmp`);
  try {
    const json = JSON.stringify(data);
    fs.writeFileSync(temp, json, "utf-8");
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already renamed or gone */ }
  }
}

// === 状态管理 ===

function loadIndex() {
  if (_cachedIndex) return _cachedIndex;
  try {
    _cachedIndex = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
    return _cachedIndex;
  } catch {
    return null;
  }
}

function saveIndex(index) {
  _cachedIndex = index;
  atomicWriteJson(INDEX_FILE, index);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { dirty_pages: [], dirty_log: false, freshness: "unknown", last_successful_refresh_at: null, last_refresh_attempt_at: null, last_refresh_failed_at: null, last_refresh_error: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { dirty_pages: [], dirty_log: false, freshness: "unknown", last_successful_refresh_at: null, last_refresh_attempt_at: null, last_refresh_failed_at: null, last_refresh_error: null };
  }
}

function saveState(state) {
  atomicWriteJson(STATE_FILE, state);
}

function iterPages(index, { includeDeprecated = false, category = null } = {}) {
  const result = [];
  for (const [title, info] of Object.entries(index.pages || {})) {
    if (!includeDeprecated && info.deprecated) continue;
    if (category !== null && info.category !== category) continue;
    result.push({ title, ...info });
  }
  return result;
}

// === 飞书发现 / 遍历 ===

function _autoDiscoverSpaceAndRoot() {
  const r = lark.run([
    "wiki", "spaces", "list", "--as", "user",
    "--params", JSON.stringify({ page_size: 50 }),
  ]);
  if (!lark.isSuccess(r)) return null;
  const spaces = (r.data && r.data.items) || [];

  let target = spaces.find(
    (s) => (s.name || "").includes("AI Wiki") || (s.name || "").includes("AI 维基")
  );
  if (!target && spaces.length === 1) target = spaces[0];
  if (!target) return null;

  const spaceId = target.space_id;
  const r2 = lark.run([
    "wiki", "nodes", "list", "--as", "user",
    "--params", JSON.stringify({ space_id: spaceId, page_size: 50 }),
  ]);
  if (!lark.isSuccess(r2)) return null;
  const roots = (r2.data && r2.data.items) || [];

  let root = roots.find(
    (n) =>
      ["AI Wiki", "AI 维基", "AI维基"].includes(n.title || "") &&
      n.obj_type === "docx"
  );
  if (!root) root = roots.find((n) => n.obj_type === "docx");
  if (!root) return null;

  return {
    space_id: spaceId,
    root_node_token: root.node_token,
    root_obj_token: root.obj_token,
  };
}

// === 索引构建 ===

function buildIndex() {
  process.stderr.write("[fw] 构建索引...\n");

  // 1. 确定 space_id 和 root
  let spaceId = null;
  let rootNodeToken = null;
  let rootObjToken = null;

  // 读配置
  const cfg = _loadConfig();
  if (cfg) {
    spaceId = cfg.space_id;
    rootNodeToken = cfg.root_node_token;
    rootObjToken = cfg.root_obj_token;
  }

  if (!spaceId) spaceId = DEFAULT_SPACE_ID;

  if (!rootNodeToken) {
    const discovered = _autoDiscoverSpaceAndRoot();
    if (!discovered) {
      throw new Error("无法发现 AI Wiki 知识空间。请创建 .feishu-config.json");
    }
    spaceId = discovered.space_id;
    rootNodeToken = discovered.root_node_token;
    rootObjToken = discovered.root_obj_token;
  }

  // 补全 root obj_token
  if (!rootObjToken && rootNodeToken) {
    const r = lark.run([
      "wiki", "spaces", "get_node", "--as", "user",
      "--params", JSON.stringify({ token: rootNodeToken }),
    ]);
    if (lark.isSuccess(r)) {
      rootObjToken = (r.data && r.data.node && r.data.node.obj_token) || null;
    }
  }

  // 2. 扫描根节点
  process.stderr.write("[fw] 扫描根节点...\n");
  const topChildren = lark.listChildren(rootNodeToken, spaceId);
  const containers = {};
  const pages = {};
  const specialDocs = {};
  let totalPages = 0;

  for (const child of topChildren) {
    const title = child.title || "";
    const nodeToken = child.node_token || "";
    const objToken = child.obj_token || "";
    const editTime = child.obj_edit_time || "";

    if (TOP_CONTAINERS.includes(title)) {
      containers[title] = {
        node_token: nodeToken,
        obj_token: objToken,
        parent: null,
        obj_edit_time: editTime,
      };
    } else if (SPECIAL_DOCS.includes(title)) {
      specialDocs[title] = {
        node_token: nodeToken,
        obj_token: objToken,
        url: `https://bytedance.larkoffice.com/wiki/${nodeToken}`,
        obj_edit_time: editTime,
      };
    } else if (child.obj_type === "docx" && title) {
      pages[title] = {
        category: null,
        parent_token: rootNodeToken,
        node_token: nodeToken,
        obj_token: objToken,
        url: `https://bytedance.larkoffice.com/wiki/${nodeToken}`,
        obj_edit_time: editTime,
        summary: "",
      };
      totalPages++;
    }
  }

  const containerNames = Object.keys(containers);
  process.stderr.write(
    `[fw] 根节点就绪：发现 ${containerNames.length} 个容器 [${containerNames.join(", ")}]，${totalPages} 个根页面\n`
  );

  // 3. 扫描容器（顺序，lark-cli 是同步的）
  for (const [name, info] of Object.entries(containers)) {
    process.stderr.write(`[fw] 扫描容器：${name} ...\n`);
    const children = lark.listChildren(info.node_token, spaceId);
    let containerPageCount = 0;
    for (const child of children) {
      const title = child.title || "";
      if (!title) continue;
      const nodeToken = child.node_token || "";
      const objToken = child.obj_token || "";
      const editTime = child.obj_edit_time || "";

      if (name === "原始资料" && RAW_SUBS.includes(title)) {
        containers[`原始资料/${title}`] = {
          node_token: nodeToken,
          obj_token: objToken,
          parent: "原始资料",
          obj_edit_time: editTime,
        };
        continue;
      }

      pages[title] = {
        category: name,
        parent_token: info.node_token,
        node_token: nodeToken,
        obj_token: objToken,
        url: `https://bytedance.larkoffice.com/wiki/${nodeToken}`,
        obj_edit_time: editTime,
        summary: "",
      };
      containerPageCount++;
      totalPages++;
    }
    process.stderr.write(
      `[fw]   ✓ ${name}：${containerPageCount} 个页面（累计 ${totalPages}）— 可探索\n`
    );
  }

  // 4. 扫描原始资料子容器
  const rawSubs = Object.entries(containers).filter(([, info]) => info.parent === "原始资料");
  for (const [cpath, info] of rawSubs) {
    process.stderr.write(`[fw] 扫描子容器：${cpath} ...\n`);
    const children = lark.listChildren(info.node_token, spaceId);
    let subPageCount = 0;
    for (const child of children) {
      const title = child.title || "";
      if (!title) continue;
      pages[title] = {
        category: cpath,
        parent_token: info.node_token,
        node_token: child.node_token || "",
        obj_token: child.obj_token || "",
        url: `https://bytedance.larkoffice.com/wiki/${child.node_token || ""}`,
        obj_edit_time: child.obj_edit_time || "",
        summary: "",
      };
      subPageCount++;
      totalPages++;
    }
    process.stderr.write(
      `[fw]   ✓ ${cpath}：${subPageCount} 个页面（累计 ${totalPages}）— 可探索\n`
    );
  }

  // 5. 保留旧索引中的 summary 和 deprecated 标记
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const oldIndex = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
      const oldPages = oldIndex.pages || {};
      for (const [title, info] of Object.entries(pages)) {
        if (oldPages[title]) {
          if (oldPages[title].summary) info.summary = oldPages[title].summary;
          if (oldPages[title].deprecated) info.deprecated = true;
        }
      }
    } catch {
      // ignore
    }
  }

  // 6. 拉取日志
  process.stderr.write("[fw] 拉取日志...\n");
  mkdirp(DOCS_DIR);
  if (specialDocs["日志"]) {
    const md = lark.fetchDocMarkdown(specialDocs["日志"].obj_token);
    fs.writeFileSync(LOG_FILE, md, "utf-8");
  }

  // 7. 检查最新包版本（best-effort，不阻塞）
  let latestVersion = null;
  try {
    const { execFileSync } = require("child_process");
    latestVersion = execFileSync("npm", ["view", "@uilcire/ai-wiki", "version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch { /* offline — skip */ }

  // 8. 写索引
  const index = {
    built_at: new Date().toISOString(),
    space_id: spaceId,
    root: { node_token: rootNodeToken, obj_token: rootObjToken },
    containers,
    pages,
    special_docs: specialDocs,
    latest_package_version: latestVersion,
  };
  mkdirp(CACHE_DIR);
  saveIndex(index);

  // 9. 初始化 state
  if (!fs.existsSync(STATE_FILE)) {
    saveState({
      started_at: new Date().toISOString(),
      dirty_pages: [],
      dirty_log: false,
      last_sync_at: null,
    });
  }

  const pageCount = Object.keys(pages).length;
  const containerCount = Object.keys(containers).length;
  process.stderr.write(
    `[fw] 索引就绪：${pageCount} 个页面，${containerCount} 个容器\n`
  );
  return index;
}

function _checkVersionNotice(index) {
  if (!index || !index.latest_package_version) return;
  if (index.latest_package_version !== VERSION) {
    process.stderr.write(
      `[fw] ⚠️  新版本可用：${VERSION} → ${index.latest_package_version}，运行 ai-wiki upgrade 升级\n`
    );
  }
}

function refreshIndexIfStale() {
  const now = Date.now() / 1000;
  if (fs.existsSync(INDEX_FILE) && now - _indexLastRefresh < INDEX_TTL) {
    const cached = loadIndex();
    if (cached) {
      _checkVersionNotice(cached);
      return cached;
    }
    // corrupted — fall through to rebuild
  }
  // TTL 过期或无索引 — 清空内存缓存，重建
  _cachedIndex = null;

  const state = loadState();
  state.last_refresh_attempt_at = new Date().toISOString();

  if (fs.existsSync(INDEX_FILE)) {
    try {
      const index = buildIndex();
      _indexLastRefresh = now;
      state.freshness = "fresh";
      state.last_successful_refresh_at = new Date().toISOString();
      state.last_refresh_error = null;
      saveState(state);
      return index;
    } catch (err) {
      // Rebuild failed — use stale cache as fallback
      state.last_refresh_failed_at = new Date().toISOString();
      state.last_refresh_error = (err.message || String(err)).slice(0, 500);

      const cached = loadIndex();
      if (cached) {
        _indexLastRefresh = now;
        state.freshness = "stale-fallback";
        saveState(state);
        process.stderr.write(
          `[fw] ⚠️  索引刷新失败，使用缓存数据（构建于 ${cached.built_at || "未知"}）\n` +
          `[fw]    原因：${state.last_refresh_error}\n`
        );
        return cached;
      }
      saveState(state);
    }
  }
  // No index at all — build synchronously
  const index = buildIndex();
  _indexLastRefresh = now;
  state.freshness = "fresh";
  state.last_successful_refresh_at = new Date().toISOString();
  state.last_refresh_error = null;
  saveState(state);
  return index;
}

function isBuilding() {
  if (!fs.existsSync(BUILDING_FILE)) return false;
  // Check if the builder process is still alive
  try {
    const pid = parseInt(fs.readFileSync(BUILDING_FILE, "utf-8").trim(), 10);
    if (pid) {
      process.kill(pid, 0); // throws if process doesn't exist
      return true;
    }
  } catch {
    // Process gone — stale file, clean up
    try { fs.unlinkSync(BUILDING_FILE); } catch { /* ignore */ }
  }
  return false;
}

function spawnBackgroundBuild() {
  const { spawn } = require("child_process");
  const script = path.join(__dirname, "..", "scripts", "build-index.js");
  const child = spawn(process.execPath, [script], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  process.stderr.write("[fw] 索引正在后台构建中...\n");
}

function ensureCache() {
  if (_cacheReady) return;
  mkdirp(DOCS_DIR);
  if (!fs.existsSync(INDEX_FILE) || !fs.existsSync(STATE_FILE)) {
    // No index — build synchronously so callers get real data
    buildIndex();
    _indexLastRefresh = Date.now() / 1000;
    const state = loadState();
    state.freshness = "fresh";
    state.last_successful_refresh_at = new Date().toISOString();
    saveState(state);
  } else {
    // Index exists — seed _indexLastRefresh from file mtime so TTL check works
    // across process boundaries (each CLI invocation starts with _indexLastRefresh=0)
    _indexLastRefresh = fs.statSync(INDEX_FILE).mtimeMs / 1000;
  }
  _cacheReady = true;
}

// === 查找 / 读取 ===

function find(query, { category = null, includeDeprecated = false } = {}) {
  ensureCache();
  const index = refreshIndexIfStale();
  const pages = index.pages || {};

  // 精确匹配
  if (pages[query]) {
    const page = pages[query];
    if (!includeDeprecated && page.deprecated) {
      // skip
    } else if (category === null || page.category === category) {
      _logQaEvent("call:find", query, query);
      return { ...page, title: query };
    }
  }

  // 模糊匹配
  const filtered = iterPages(index, { includeDeprecated, category });
  const matches = filtered.filter(
    (p) => p.title.includes(query) || query.includes(p.title)
  );

  if (matches.length) {
    matches.sort((a, b) => a.title.length - b.title.length);
    _logQaEvent("call:find", query, matches[0].title);
    return matches[0];
  }
  _logQaEvent("call:find", query, "(no match)");
  return null;
}

function listPages({ category = null, includeDeprecated = false } = {}) {
  ensureCache();
  const index = refreshIndexIfStale();
  return iterPages(index, { includeDeprecated, category });
}

function exists(title) {
  ensureCache();
  const index = refreshIndexIfStale();
  return title in (index.pages || {});
}

function fetch(pageOrTitle, { fresh = false } = {}) {
  ensureCache();
  let title;
  if (typeof pageOrTitle === "object" && pageOrTitle !== null) {
    title = pageOrTitle.title || "";
  } else {
    title = pageOrTitle;
  }

  const index = refreshIndexIfStale();
  let pageInfo = (index.pages || {})[title];
  if (!pageInfo) {
    const found = find(title);
    if (!found) throw new Error(`找不到页面: ${title}`);
    title = found.title;
    pageInfo = found;
  }

  const cachePath = docCachePath(title);
  const objToken = pageInfo.obj_token || "";
  const state = loadState();
  const cachedTimes = state.cached_edit_times || {};

  if (!fresh && fs.existsSync(cachePath)) {
    if (cachedTimes[title] === (pageInfo.obj_edit_time || "")) {
      const md = fs.readFileSync(cachePath, "utf-8");
      _logQaEvent("call:fetch", title, md.slice(0, 200));
      return md;
    }
  }

  if (!objToken) throw new Error(`页面 ${title} 没有 obj_token`);
  process.stderr.write(`[fw] 正在拉取: ${title}...\n`);
  const md = lark.fetchDocMarkdown(objToken);
  mkdirp(DOCS_DIR);
  fs.writeFileSync(cachePath, md, "utf-8");

  if (!state.cached_edit_times) state.cached_edit_times = {};
  state.cached_edit_times[title] = pageInfo.obj_edit_time || "";
  saveState(state);

  _logQaEvent("call:fetch", title, md.slice(0, 200));
  return md;
}

function link(pageOrTitle) {
  ensureCache();
  let title, url;
  if (typeof pageOrTitle === "object" && pageOrTitle !== null) {
    url = pageOrTitle.url || "";
    title = pageOrTitle.title || "";
  } else {
    title = pageOrTitle;
    const page = find(title);
    if (!page) throw new Error(`找不到页面: ${title}`);
    url = page.url || "";
  }
  if (!url) throw new Error(`页面 ${title} 没有 URL`);
  return url;
}

// === Attribution callout ===

const CALLOUT_RE =
  /<callout emoji="(?:👤|bust_in_silhouette|member|user)"[^>]*>[\s\S]*?<\/callout>/;

function _makeAttributionCallout(createdBy, updatedBy, createdAt, updatedAt) {
  const cn = createdBy.name || "unknown";
  const un = updatedBy.name || "unknown";
  const cd = (createdAt || "").slice(0, 10);
  const ud = (updatedAt || "").slice(0, 10);
  return (
    `<callout emoji="👤" background-color="light-gray-background">\n` +
    `**创建**：${cn}（${cd}） · **最后更新**：${un}（${ud}）\n` +
    `</callout>`
  );
}

function _extractAttribution(content) {
  const m = content.match(
    /<callout emoji="(?:👤|bust_in_silhouette)"[^>]*>([\s\S]*?)<\/callout>/
  );
  if (!m) return null;
  const body = m[1];
  const cm = body.match(/\*\*创建\*\*：([^（]+)（([^）]*)）/);
  const um = body.match(/\*\*最后更新\*\*：([^（]+)（([^）]*)）/);
  return {
    created_name: cm ? cm[1].trim() : null,
    created_date: cm ? cm[2].trim() : null,
    updated_name: um ? um[1].trim() : null,
    updated_date: um ? um[2].trim() : null,
  };
}

function _upsertAttribution(content, isCreate) {
  const user = lark.currentUser();
  const today = new Date().toISOString().slice(0, 10);

  const existing = _extractAttribution(content);
  let created, createdAt;
  if (existing && existing.created_name) {
    created = { name: existing.created_name };
    createdAt = existing.created_date || today;
  } else {
    created = user;
    createdAt = today;
  }

  const newCallout = _makeAttributionCallout(created, user, createdAt, today);

  if (existing) {
    return content.replace(
      /<callout emoji="(?:👤|bust_in_silhouette)"[^>]*>[\s\S]*?<\/callout>/,
      newCallout
    );
  }

  // 在其他 callout 后面插入
  const otherMatch = content.match(
    /^((?:<callout[^>]*>[\s\S]*?<\/callout>\s*)*)/
  );
  if (otherMatch && otherMatch[1]) {
    const prefix = otherMatch[1];
    const rest = content.slice(prefix.length);
    return prefix + newCallout + "\n\n" + rest;
  }
  return newCallout + "\n\n" + content;
}

// === 写权限检查 ===

function _checkWritePermission() {
  const configPath = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".feishu-wiki-config.json"
  );
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (!cfg.write_enabled) {
        throw new Error(
          "当前为学习模式（只读），不能修改维基。\n" +
          "如需切换到贡献模式，运行：ai-wiki mode write"
        );
      }
    } catch (err) {
      if (err.message.includes("学习模式")) throw err;
    }
  }
}

// === 容器页同步 ===

function _syncContainerPage(category) {
  if (category.includes("/")) return;

  const index = loadIndex();
  const container = (index.containers || {})[category];
  if (!container || !container.obj_token) return;

  const children = iterPages(index, { category })
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((p) => [p.title, p]);

  const lines = [`\`\`\`plaintext\n${category}`];
  children.forEach(([title], i) => {
    const connector = i === children.length - 1 ? "└──" : "├──";
    lines.push(`${connector} ${title}`);
  });
  lines.push("```");
  lines.push("");
  lines.push(`## 本分类页面（共 ${children.length} 个）`);
  for (const [title, info] of children) {
    const ot = info.obj_token || "";
    if (ot) {
      lines.push(
        `- <mention-doc token="${ot}" type="docx">${title}</mention-doc>`
      );
    } else {
      lines.push(`- ${title}`);
    }
  }

  const content = lines.join("\n") + "\n";
  lark.uploadPage(category, container.obj_token, content);
  process.stderr.write(
    `[fw] 容器页已同步: ${category}（${children.length} 个页面）\n`
  );

  _syncRootPage();
}

function _syncRootPage() {
  const index = loadIndex();
  const rootObjToken = (index.root || {}).obj_token;
  if (!rootObjToken) return;

  const byCat = {};
  for (const p of iterPages(index)) {
    const cat = p.category || "";
    if (cat && !cat.includes("/")) {
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push([p.title, p]);
    }
  }

  const topCats = ["来源", "主题", "实体", "综合"];

  const lines = [
    "本知识库采用**卡帕西 LLM 维基模式**：LLM 在收录来源时将知识编译进持久的、" +
      "互相链接的维基中。新来源加入时，维基自动增长并维护交叉引用。",
    "",
    "## 整体架构",
    "```plaintext",
    "AI Wiki",
    "├── 索引",
  ];

  topCats.forEach((cat, ci) => {
    const catPages = byCat[cat] || [];
    const isLast = ci === topCats.length - 1;
    const branch = isLast ? "└──" : "├──";
    lines.push(`${branch} ${cat}/ (${catPages.length})`);
    catPages.forEach(([title], pi) => {
      const prefix = isLast ? "    " : "│   ";
      const connector = pi === catPages.length - 1 ? "└──" : "├──";
      lines.push(`${prefix}${connector} ${title}`);
    });
  });

  lines.push("```", "", "## 导航", "");

  for (const cat of topCats) {
    const catPages = byCat[cat] || [];
    const container = (index.containers || {})[cat] || {};
    const catToken = container.obj_token || "";
    lines.push(
      `- <mention-doc token="${catToken}" type="docx">${cat}</mention-doc>` +
        ` (${catPages.length})`
    );
    for (const [title, info] of catPages) {
      const ot = info.obj_token || "";
      lines.push(
        `  - <mention-doc token="${ot}" type="docx">${title}</mention-doc>`
      );
    }
  }

  // 嵌入 token 清单（供 search 在索引未就绪时使用）
  const allTokens = iterPages(index).map((p) => p.obj_token).filter(Boolean);
  lines.push("");
  lines.push(`<!-- wiki-tokens:${allTokens.join(",")} -->`);

  const content = lines.join("\n") + "\n";
  lark.uploadPage("AI Wiki", rootObjToken, content);
  process.stderr.write("[fw] 根页面已同步\n");
}

// === 创建 / 更新 / 删除 ===

function create(category, title, content, { summary = "" } = {}) {
  const lock = require("./lock");
  _checkWritePermission();
  ensureCache();
  process.stderr.write(`[fw] 正在创建: ${title}...\n`);

  if (!ALL_CATEGORIES.includes(category) && category !== "原始资料") {
    throw new Error(`无效分类: ${category}，可选: ${ALL_CATEGORIES.join(", ")}`);
  }
  if (exists(title)) {
    throw new Error(`页面已存在: ${title}（请用 update）`);
  }

  function doCreate() {
    const index = loadIndex();
    const container = (index.containers || {})[category];
    if (!container) throw new Error(`找不到分类容器: ${category}`);
    const parentToken = container.node_token;

    const resolved = resolveWikilinks(content);
    const attributed = _upsertAttribution(resolved, true);

    const r = lark.run(
      [
        "docs", "+create", "--as", "user",
        "--wiki-node", parentToken,
        "--title", title,
        "--markdown", attributed,
      ],
      { check: true }
    );
    if (!lark.isSuccess(r)) throw new Error(`create 失败: ${JSON.stringify(r)}`);

    const data = r.data || {};
    const docId = data.doc_id;
    const docUrl = data.doc_url || "";
    const nodeToken = docUrl.includes("/wiki/") ? docUrl.split("/").pop() : "";

    mkdirp(DOCS_DIR);
    fs.writeFileSync(docCachePath(title), attributed, "utf-8");

    const newPage = {
      category,
      parent_token: parentToken,
      node_token: nodeToken,
      obj_token: docId,
      url: docUrl,
      obj_edit_time: "",
      summary,
    };
    if (!index.pages) index.pages = {};
    index.pages[title] = newPage;
    saveIndex(index);

    const state = loadState();
    if (!state.cached_edit_times) state.cached_edit_times = {};
    state.cached_edit_times[title] = "";
    saveState(state);

    appendLog("创建", title, { mode: category });
    _syncContainerPage(category);
    return { title, ...newPage };
  }

  if (lock.isLocked()) return doCreate();
  return lock.withLock(doCreate);
}

function update(pageOrTitle, content, { mode = "append", summary = "" } = {}) {
  const lock = require("./lock");
  _checkWritePermission();
  ensureCache();

  const title =
    typeof pageOrTitle === "object" && pageOrTitle !== null
      ? pageOrTitle.title || ""
      : pageOrTitle;
  process.stderr.write(`[fw] 正在更新: ${title}...\n`);

  function doUpdate() {
    const page = find(title);
    if (!page) throw new Error(`找不到页面: ${title}`);

    const current = fetch(title, { fresh: true });

    const resolvedContent = resolveWikilinks(content);
    let newContent;
    if (mode === "append") {
      newContent = current.trimEnd() + "\n\n" + resolvedContent;
    } else if (mode === "overwrite") {
      newContent = resolvedContent;
    } else {
      throw new Error(`不支持的 mode: ${mode}`);
    }

    newContent = _upsertAttribution(newContent, false);

    const objToken = page.obj_token || "";
    if (!objToken) throw new Error(`页面 ${title} 没有 obj_token`);
    lark.uploadPage(title, objToken, newContent);

    mkdirp(DOCS_DIR);
    fs.writeFileSync(docCachePath(title), newContent, "utf-8");

    if (summary) {
      const index = loadIndex();
      if (index.pages && index.pages[title]) {
        index.pages[title].summary = summary;
        saveIndex(index);
      }
    }

    appendLog("更新", title, { mode });
  }

  if (lock.isLocked()) doUpdate();
  else lock.withLock(doUpdate);
}

function del(pageOrTitle, { reason = "" } = {}) {
  const lock = require("./lock");
  _checkWritePermission();
  ensureCache();

  const title =
    typeof pageOrTitle === "object" && pageOrTitle !== null
      ? pageOrTitle.title || ""
      : pageOrTitle;
  process.stderr.write(`[fw] 正在废弃: ${title}...\n`);

  function doDelete() {
    const page = find(title, { includeDeprecated: true });
    if (!page) throw new Error(`找不到页面: ${title}`);
    if (page.deprecated) {
      process.stderr.write(`[fw] 页面「${title}」已经是废弃状态，跳过\n`);
      return;
    }

    const current = fetch(title, { fresh: true });
    const today = new Date().toISOString().slice(0, 10);
    const reasonText = reason ? `\n**原因**：${reason}` : "";
    const deprecationCallout =
      `<callout emoji="🗑️" background-color="red-background">\n` +
      `**[已废弃]**（${today}）${reasonText}\n` +
      `此页面已停用，内容仅供历史参考。\n` +
      `</callout>\n\n`;

    const newContent = deprecationCallout + current;
    const objToken = page.obj_token || "";
    if (!objToken) throw new Error(`页面 ${title} 没有 obj_token`);
    lark.uploadPage(title, objToken, newContent);

    mkdirp(DOCS_DIR);
    fs.writeFileSync(docCachePath(title), newContent, "utf-8");

    const index = loadIndex();
    if (index.pages && index.pages[title]) {
      index.pages[title].deprecated = true;
      saveIndex(index);
    }

    appendLog("废弃", title, { reason: reason || "无说明" });
    const cat = page.category || "";
    if (cat) _syncContainerPage(cat);
  }

  if (lock.isLocked()) doDelete();
  else lock.withLock(doDelete);
}

// === 日志 ===

function appendLog(action, title, { mode = "", reason = "" } = {}) {
  ensureCache();
  const today = new Date().toISOString().slice(0, 10);
  const user = lark.currentUser();
  const userMention = user.open_id
    ? `<mention-user id="${user.open_id}">${user.name}</mention-user>`
    : user.name;

  const extra = mode || reason;
  const line = extra ? `- ${title} (${extra})\n` : `- ${title}\n`;
  const sectionHeader = `## [${today}] ${action} · ${userMention}\n`;

  if (fs.existsSync(LOG_FILE)) {
    let existing = fs.readFileSync(LOG_FILE, "utf-8");
    if (existing.includes(sectionHeader)) {
      existing = existing.trimEnd() + "\n" + line;
    } else {
      existing = existing.trimEnd() + "\n\n" + sectionHeader + line;
    }
    fs.writeFileSync(LOG_FILE, existing, "utf-8");
  } else {
    mkdirp(CACHE_DIR);
    fs.writeFileSync(LOG_FILE, `# 日志\n\n${sectionHeader}${line}`, "utf-8");
  }
  const state = loadState();
  state.dirty_log = true;
  saveState(state);
}

// === 同步 ===

function sync() {
  flushQaEvents();
  const state = loadState();
  if (!state.dirty_log) return { uploaded: 0 };

  const index = loadIndex();
  let uploaded = 0;

  if (state.dirty_log && (index.special_docs || {})["日志"]) {
    const logInfo = index.special_docs["日志"];
    const content = fs.existsSync(LOG_FILE)
      ? fs.readFileSync(LOG_FILE, "utf-8")
      : "# 日志\n";
    lark.uploadPage("日志", logInfo.obj_token, content);
    uploaded++;
  }

  state.dirty_log = false;
  state.last_sync_at = new Date().toISOString();
  saveState(state);

  process.stderr.write(`[fw] ✓ 已同步 ${uploaded} 项\n`);
  return { uploaded };
}

function refresh() {
  sync();
  flushQaEvents();
  _cacheReady = false;
  _cachedIndex = null;
  _indexLastRefresh = 0;
  buildIndex();
  _indexLastRefresh = Date.now() / 1000;
  _cacheReady = true;
  // Mark freshness after explicit refresh
  const state = loadState();
  state.freshness = "fresh";
  state.last_successful_refresh_at = new Date().toISOString();
  state.last_refresh_error = null;
  saveState(state);
}

function status() {
  if (!fs.existsSync(INDEX_FILE)) {
    if (isBuilding()) return { cache: "building", version: VERSION };
    return { cache: "missing" };
  }
  const index = loadIndex();
  if (!index) return { cache: "corrupted", version: VERSION };
  const state = loadState();
  return {
    cache: "ready",
    freshness: state.freshness || "unknown",
    built_at: index.built_at,
    pages: Object.keys(index.pages || {}).length,
    dirty_log: state.dirty_log || false,
    last_sync_at: state.last_sync_at || null,
    last_successful_refresh_at: state.last_successful_refresh_at || null,
    last_refresh_failed_at: state.last_refresh_failed_at || null,
    last_refresh_error: state.last_refresh_error || null,
    version: VERSION,
  };
}

// === 云端 token 清单（供 search 在索引未就绪时使用）===

let _cloudTokensCache = null;

function loadWikiTokensFromCloud() {
  if (_cloudTokensCache) return _cloudTokensCache;

  // 读配置获取 root obj_token
  const cfg = _loadConfig();
  const rootObjToken = cfg ? cfg.root_obj_token : null;
  if (!rootObjToken) return null;

  try {
    const md = lark.fetchDocMarkdown(rootObjToken);
    const m = md.match(/<!-- wiki-tokens:(.+?) -->/);
    if (m && m[1]) {
      const tokens = new Set(m[1].split(",").filter(Boolean));
      _cloudTokensCache = tokens;
      return tokens;
    }
  } catch { /* ignore */ }
  return null;
}

// === 维基链接解析 ===

function resolveWikilinks(content) {
  ensureCache();
  return content.replace(/\[\[([^\]]+)\]\]/g, (match, raw) => {
    let target, display;
    if (raw.includes("|")) {
      [target, display] = raw.split("|", 2);
    } else {
      target = display = raw;
    }
    const page = find(target.trim());
    if (page && page.obj_token) {
      return `<mention-doc token="${page.obj_token}" type="docx">${display.trim()}</mention-doc>`;
    }
    return `**${display.trim()}**`;
  });
}

// === 反馈 ===

const FEEDBACK_BASE_TOKEN = "Xpl0bjOSPaycQ6s3FJ1cqYIFnqc";
const FEEDBACK_TABLE_ID = "tblGOdsAlb1CzbqB";

function feedback(content) {
  const user = lark.currentUser();
  const fields = {
    反馈内容: content,
    提交人: user.name,
    版本号: VERSION,
    时间戳: Date.now(),
    状态: "待处理",
  };

  try {
    const r = lark.run([
      "base", "+record-upsert",
      "--base-token", FEEDBACK_BASE_TOKEN,
      "--table-id", FEEDBACK_TABLE_ID,
      "--json", JSON.stringify(fields),
    ]);
    if (r && r.ok) {
      const ids =
        (r.data && r.data.record && r.data.record.record_id_list) || [];
      return { ok: true, record_id: ids[0] || "" };
    }
    const err = (r && r.error && r.error.message) || "未知错误";
    return { ok: false, error: err };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// === QA 日志 ===

function logQa(question, answer, tools) {
  if (!QA_LOG_ENABLED) return { ok: true, session_id: QA_SESSION_ID };

  const user = lark.currentUser();
  const hasError = (tools || []).some((t) => t.error);
  const errorDetails = (tools || [])
    .filter((t) => t.error)
    .map((t) => `${t.name}: ${t.error}`);

  const entry = {
    session_id: QA_SESSION_ID,
    user_name: user.name,
    user_open_id: user.open_id,
    event_type: "qa_log",
    input: (question || "").slice(0, 2000),
    output_summary: (answer || "").slice(0, 2000),
    tools_trace: JSON.stringify(tools || []).slice(0, 2000),
    has_error: hasError,
    error_detail: errorDetails.join("; ").slice(0, 2000),
    timestamp: Date.now(),
    version: VERSION,
  };

  try {
    mkdirp(CACHE_DIR);
    fs.appendFileSync(QA_QUEUE_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // best-effort
  }
  return { ok: true, session_id: QA_SESSION_ID };
}

// === lint ===

function lint() {
  ensureCache();
  const index = refreshIndexIfStale();
  const allPagesObj = index.pages || {};
  process.stderr.write(`[fw] 正在检查: ${Object.keys(allPagesObj).length} 个页面...\n`);

  // Use iterPages for clean active/all separation
  const pages = iterPages(index);
  const allWithDep = iterPages(index, { includeDeprecated: true });

  const byCat = {};
  for (const p of pages) {
    const cat = p.category || "无分类";
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(p);
  }

  // title → page Map，O(1) 查找代替 Array.find
  const pageByTitle = new Map(pages.map((p) => [p.title, p]));

  // token → title 映射
  const tokenMap = {};
  for (const p of allWithDep) {
    if (p.obj_token) tokenMap[p.obj_token] = p.title;
  }

  // 内容缓存：每个页面只 fetch 一次
  const contentCache = new Map();
  function getContent(title) {
    if (contentCache.has(title)) return contentCache.get(title);
    let content;
    try { content = fetch(title); } catch { content = null; }
    contentCache.set(title, content);
    return content;
  }

  function getRefs(title) {
    const content = getContent(title);
    if (!content) return new Set();
    const refs = new Set();
    const wikiLinkRe = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
    let m;
    while ((m = wikiLinkRe.exec(content))) refs.add(m[1].trim());
    const mentionRe =
      /<mention-doc[^>]*token="([^"]+)"[^>]*>([^<]+)<\/mention-doc>/g;
    while ((m = mentionRe.exec(content))) {
      refs.add(tokenMap[m[1]] || m[2].trim());
    }
    return refs;
  }

  // 预计算所有页面的 refs，后续检查直接复用
  const refsCache = new Map();
  for (const p of pages) {
    refsCache.set(p.title, getRefs(p.title));
  }

  const issues = [];
  const allTitles = new Set(allWithDep.map((p) => p.title));

  // 1. 断链
  for (const p of pages) {
    for (const ref of refsCache.get(p.title)) {
      if (!allTitles.has(ref)) {
        issues.push({
          type: "断链",
          page: p.title,
          detail: `引用了不存在的页面 [[${ref}]]`,
        });
      }
    }
  }

  // 2. 孤立页面
  const inlinks = {};
  for (const p of pages) inlinks[p.title] = 0;
  for (const p of pages) {
    for (const ref of refsCache.get(p.title)) {
      if (ref in inlinks) inlinks[ref]++;
    }
  }
  const skipTitles = new Set(["索引", "日志", "队列"]);
  for (const [title, count] of Object.entries(inlinks)) {
    if (count === 0 && !skipTitles.has(title)) {
      issues.push({ type: "孤立", page: title, detail: "没有任何页面引用此页" });
    }
  }

  // 3. 来源页交叉引用
  const sourceRefs = {};
  for (const p of byCat["来源"] || []) {
    const refs = refsCache.get(p.title);
    sourceRefs[p.title] = refs;
    const refCats = new Set();
    for (const ref of refs) {
      const rp = pageByTitle.get(ref);
      if (rp) refCats.add(rp.category || "");
    }
    if (![...refCats].some((c) => c && c.includes("原始资料"))) {
      issues.push({
        type: "来源缺归档",
        page: p.title,
        detail: "来源页未引用对应的原始资料归档",
      });
    }
    if (
      ![...refCats].some((c) => c === "主题" || c === "实体")
    ) {
      issues.push({
        type: "来源缺主题/实体",
        page: p.title,
        detail: "来源页未引用任何主题或实体页面",
      });
    }
  }

  // 4. 未解析的 wikilinks（[[]] 应在写入时转为 <mention-doc>）
  for (const p of pages) {
    const content = getContent(p.title);
    if (!content) continue;
    const unresolvedRe = /\[\[([^\]]+?)\]\]/g;
    let m;
    const seen = new Set();
    while ((m = unresolvedRe.exec(content))) {
      const target = m[1].split("|")[0].trim();
      if (!seen.has(target)) {
        seen.add(target);
        issues.push({
          type: "未解析链接",
          page: p.title,
          detail: `页面中残留 [[${target}]]，应为 <mention-doc> 格式`,
        });
      }
    }
  }

  // 5. 主题/实体无来源引用
  for (const cat of ["主题", "实体"]) {
    for (const p of byCat[cat] || []) {
      const referrers = Object.entries(sourceRefs).filter(([, refs]) =>
        refs.has(p.title)
      );
      if (!referrers.length) {
        issues.push({
          type: `${cat}无来源`,
          page: p.title,
          detail: `${cat}页未被任何来源页引用`,
        });
      }
    }
  }

  // Stats
  const cats = {};
  for (const p of pages) {
    const c = p.category || "无分类";
    cats[c] = (cats[c] || 0) + 1;
  }

  const stats = {
    total: pages.length,
    deprecated: allWithDep.length - pages.length,
    categories: cats,
    issues: issues.length,
  };

  process.stderr.write(
    `[fw] lint: ${stats.total} 页, ${stats.deprecated} 废弃, ${issues.length} 个问题\n`
  );
  for (const issue of issues) {
    process.stderr.write(
      `  [${issue.type}] ${issue.page}: ${issue.detail}\n`
    );
  }

  return { ok: issues.length === 0, stats, issues };
}

module.exports = {
  // 读
  find,
  listPages,
  exists,
  fetch,
  link,
  loadWikiTokensFromCloud,
  // 写
  create,
  update,
  del,
  // 管理
  status,
  sync,
  refresh,
  lint,
  appendLog,
  resolveWikilinks,
  feedback,
  logQa,
  flushQaEvents,
  // 内部（给 lock.js / build-index.js / 测试用）
  iterPages,
  ensureCache,
  loadIndex,
  saveIndex,
  docCachePath,
  isBuilding,
  _buildIndexSync: buildIndex,
  _invalidateCache() { _cachedIndex = null; _configCache = undefined; },
  CACHE_DIR,
  DOCS_DIR,
};
