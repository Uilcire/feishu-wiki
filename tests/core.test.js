/**
 * core.test.js — tests for lib/core.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJ = path.resolve(__dirname, "..");
const CORE_PATH = require.resolve(path.join(PROJ, "lib/core.js"));
const LARK_PATH = require.resolve(path.join(PROJ, "lib/lark.js"));
const LOCK_PATH = require.resolve(path.join(PROJ, "lib/lock.js"));

let tmpDir;
let origCwd;
let origStderrWrite;

function makeMockLark() {
  return {
    run: () => ({ ok: true }),
    isSuccess: (r) => Boolean(r) && (r.ok || r.code === 0),
    currentUser: () => ({ name: "TestUser", open_id: "ou_test" }),
    fetchDocMarkdown: () => "",
    uploadPage: () => {},
    listChildren: () => [],
  };
}

function makeMockLock() {
  return {
    isLocked: () => false,
    withLock: (fn) => fn(),
  };
}

function setupEnv() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-test-"));
  origCwd = process.cwd();
  process.chdir(tmpDir);
  origStderrWrite = process.stderr.write;
  process.stderr.write = () => true;

  // Write config so buildIndex skips auto-discovery
  fs.writeFileSync(
    path.join(tmpDir, ".feishu-config.json"),
    JSON.stringify({ space_id: "sp_test", root_node_token: "nt_root", root_obj_token: "ot_root" }),
    "utf-8"
  );

  // Inject mocks
  require.cache[LARK_PATH] = { id: LARK_PATH, filename: LARK_PATH, loaded: true, exports: makeMockLark() };
  require.cache[LOCK_PATH] = { id: LOCK_PATH, filename: LOCK_PATH, loaded: true, exports: makeMockLock() };
  delete require.cache[CORE_PATH];

  return require(CORE_PATH);
}

function cleanupEnv() {
  delete require.cache[CORE_PATH];
  delete require.cache[LARK_PATH];
  delete require.cache[LOCK_PATH];
  process.stderr.write = origStderrWrite;
  process.chdir(origCwd);
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Helper to write a pre-built index.
// Write files first so ensureCache() sees them (skips background build).
// Then trigger one refreshIndexIfStale() cycle to set _indexLastRefresh via buildIndex (empty mock).
// Then overwrite with our desired data — TTL won't expire within the test.
function writeIndex(core, dir, index) {
  const cacheDir = path.join(dir, ".cache");
  fs.mkdirSync(path.join(cacheDir, "docs"), { recursive: true });
  // Write placeholder so ensureCache doesn't spawn background builder
  fs.writeFileSync(path.join(cacheDir, "index.json"), "{}", "utf-8");
  fs.writeFileSync(
    path.join(cacheDir, "state.json"),
    JSON.stringify({ dirty_pages: [], dirty_log: false }),
    "utf-8"
  );
  // ensureCache sees files exist → sets _cacheReady, no build triggered
  core.ensureCache();
  // Force one sync rebuild to set _indexLastRefresh (mock lark returns empty, that's OK)
  core.find("__warmup__");
  // Now overwrite with our desired index — TTL is fresh, won't rebuild again
  fs.writeFileSync(path.join(cacheDir, "index.json"), JSON.stringify(index), "utf-8");
  fs.writeFileSync(
    path.join(cacheDir, "state.json"),
    JSON.stringify({ dirty_pages: [], dirty_log: false, cached_edit_times: {} }),
    "utf-8"
  );
  // 清空内存缓存，使 loadIndex 读取磁盘上的新数据
  core._invalidateCache();
}

function makeIndex(pages = {}, containers = {}) {
  return {
    built_at: new Date().toISOString(),
    space_id: "test_space",
    root: { node_token: "nt_root", obj_token: "ot_root" },
    containers,
    pages,
    special_docs: {
      "日志": { obj_token: "ot_log", node_token: "nt_log", url: "" },
    },
  };
}

// ---------------------------------------------------------------------------
// docCachePath / safeFilename
// ---------------------------------------------------------------------------

describe("docCachePath", () => {
  afterEach(cleanupEnv);

  it("returns path under .cache/docs", () => {
    const core = setupEnv();
    const p = core.docCachePath("Test Page");
    assert.ok(p.includes(".cache"));
    assert.ok(p.includes("docs"));
    assert.ok(p.endsWith("Test Page.md"));
  });

  it("replaces special characters with underscore", () => {
    const core = setupEnv();
    const p = core.docCachePath('a/b:c*d?"e<f>g|h');
    const basename = path.basename(p, ".md");
    assert.ok(!basename.includes("/"));
    assert.ok(!basename.includes(":"));
    assert.ok(!basename.includes("*"));
    assert.ok(!basename.includes("?"));
    assert.ok(!basename.includes('"'));
    assert.ok(!basename.includes("<"));
    assert.ok(!basename.includes(">"));
    assert.ok(!basename.includes("|"));
  });
});

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

describe("find", () => {
  afterEach(cleanupEnv);

  it("returns exact match", () => {
    const core = setupEnv();
    const pages = {
      "RAG": { category: "主题", obj_token: "ot_rag", node_token: "nt_rag", url: "" },
    };
    writeIndex(core, tmpDir, makeIndex(pages));
    const result = core.find("RAG");
    assert.strictEqual(result.title, "RAG");
  });

  it("returns fuzzy match (substring)", () => {
    const core = setupEnv();
    const pages = {
      "检索增强生成（RAG）": { category: "主题", obj_token: "ot1", node_token: "nt1", url: "" },
    };
    writeIndex(core, tmpDir, makeIndex(pages));
    const result = core.find("RAG");
    assert.strictEqual(result.title, "检索增强生成（RAG）");
  });

  it("returns null when no match", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    assert.strictEqual(core.find("NonExistent"), null);
  });

  it("filters by category", () => {
    const core = setupEnv();
    const pages = {
      "RAG来源": { category: "来源", obj_token: "ot1", url: "" },
      "RAG主题": { category: "主题", obj_token: "ot2", url: "" },
    };
    writeIndex(core, tmpDir, makeIndex(pages));
    const result = core.find("RAG", { category: "主题" });
    assert.strictEqual(result.title, "RAG主题");
  });

  it("excludes deprecated pages by default", () => {
    const core = setupEnv();
    const pages = {
      "OldPage": { category: "主题", obj_token: "ot1", url: "", deprecated: true },
    };
    writeIndex(core, tmpDir, makeIndex(pages));
    assert.strictEqual(core.find("OldPage"), null);
  });

  it("includes deprecated when requested", () => {
    const core = setupEnv();
    const pages = {
      "OldPage": { category: "主题", obj_token: "ot1", url: "", deprecated: true },
    };
    writeIndex(core, tmpDir, makeIndex(pages));
    const result = core.find("OldPage", { includeDeprecated: true });
    assert.strictEqual(result.title, "OldPage");
  });
});

// ---------------------------------------------------------------------------
// listPages
// ---------------------------------------------------------------------------

describe("listPages", () => {
  afterEach(cleanupEnv);

  it("returns all non-deprecated pages", () => {
    const core = setupEnv();
    const pages = {
      "A": { category: "主题", obj_token: "ot1" },
      "B": { category: "来源", obj_token: "ot2" },
      "C": { category: "主题", obj_token: "ot3", deprecated: true },
    };
    writeIndex(core, tmpDir, makeIndex(pages));
    const result = core.listPages();
    assert.strictEqual(result.length, 2);
  });

  it("filters by category", () => {
    const core = setupEnv();
    const pages = {
      "A": { category: "主题", obj_token: "ot1" },
      "B": { category: "来源", obj_token: "ot2" },
    };
    writeIndex(core, tmpDir, makeIndex(pages));
    const result = core.listPages({ category: "主题" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, "A");
  });
});

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

describe("exists", () => {
  afterEach(cleanupEnv);

  it("returns true for known title", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({ "Page": { category: "主题" } }));
    assert.strictEqual(core.exists("Page"), true);
  });

  it("returns false for unknown title", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    assert.strictEqual(core.exists("Nope"), false);
  });
});

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

describe("fetch", () => {
  afterEach(cleanupEnv);

  it("returns cached content when edit time matches", () => {
    const core = setupEnv();
    const pages = {
      "TestPage": { category: "主题", obj_token: "ot1", obj_edit_time: "t1", url: "" },
    };
    const idx = makeIndex(pages);
    writeIndex(core, tmpDir, idx);

    // Write cached doc
    const cachePath = core.docCachePath("TestPage");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "# Cached Content", "utf-8");

    // Update state with cached edit time
    const stateFile = path.join(tmpDir, ".cache", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    state.cached_edit_times = { "TestPage": "t1" };
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf-8");

    const content = core.fetch("TestPage");
    assert.strictEqual(content, "# Cached Content");
  });

  it("throws when page not found", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    assert.throws(() => core.fetch("Missing"), (e) => e.message.includes("找不到页面"));
  });

  it("accepts page object with title", () => {
    const core = setupEnv();
    const pages = {
      "TestPage": { category: "主题", obj_token: "ot1", obj_edit_time: "t1", url: "" },
    };
    writeIndex(core, tmpDir, makeIndex(pages));

    // Set up mock to return content
    const mockLark = require.cache[LARK_PATH].exports;
    mockLark.fetchDocMarkdown = () => "# Fresh";

    const content = core.fetch({ title: "TestPage" });
    assert.strictEqual(content, "# Fresh");
  });
});

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

describe("link", () => {
  afterEach(cleanupEnv);

  it("returns URL for known page", () => {
    const core = setupEnv();
    const pages = {
      "TestPage": { category: "主题", obj_token: "ot1", url: "https://lark.com/wiki/abc" },
    };
    writeIndex(core, tmpDir, makeIndex(pages));
    assert.strictEqual(core.link("TestPage"), "https://lark.com/wiki/abc");
  });

  it("throws for unknown page", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    assert.throws(() => core.link("Missing"), (e) => e.message.includes("找不到页面"));
  });

  it("accepts page object with url", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    assert.strictEqual(
      core.link({ title: "X", url: "https://example.com" }),
      "https://example.com"
    );
  });

  it("throws when page has no URL", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    assert.throws(
      () => core.link({ title: "X", url: "" }),
      (e) => e.message.includes("没有 URL")
    );
  });
});

// ---------------------------------------------------------------------------
// resolveWikilinks
// ---------------------------------------------------------------------------

describe("resolveWikilinks", () => {
  afterEach(cleanupEnv);

  it("replaces [[title]] with mention-doc", () => {
    const core = setupEnv();
    const pages = { "RAG": { category: "主题", obj_token: "ot_rag", url: "" } };
    writeIndex(core, tmpDir, makeIndex(pages));
    const result = core.resolveWikilinks("See [[RAG]] for details");
    assert.ok(result.includes('mention-doc'));
    assert.ok(result.includes('ot_rag'));
    assert.ok(result.includes("RAG"));
  });

  it("handles [[target|display]] syntax", () => {
    const core = setupEnv();
    const pages = { "RAG": { category: "主题", obj_token: "ot_rag", url: "" } };
    writeIndex(core, tmpDir, makeIndex(pages));
    const result = core.resolveWikilinks("See [[RAG|检索增强]] here");
    assert.ok(result.includes("检索增强"));
    assert.ok(result.includes('ot_rag'));
  });

  it("bolds unknown page references", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const result = core.resolveWikilinks("See [[Unknown]]");
    assert.ok(result.includes("**Unknown**"));
    assert.ok(!result.includes("mention-doc"));
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("status", () => {
  afterEach(cleanupEnv);

  it("returns cache missing when no index", () => {
    const core = setupEnv();
    // Don't create index
    assert.deepStrictEqual(core.status(), { cache: "missing" });
  });

  it("returns cache ready with stats", () => {
    const core = setupEnv();
    const pages = { "A": { category: "主题" }, "B": { category: "来源" } };
    writeIndex(core, tmpDir, makeIndex(pages));
    const st = core.status();
    assert.strictEqual(st.cache, "ready");
    assert.strictEqual(st.pages, 2);
    assert.ok(st.version);
  });

  it("returns corrupted when index.json is invalid JSON", () => {
    const core = setupEnv();
    core.ensureCache();
    // Corrupt the index file and invalidate memory cache
    fs.writeFileSync(path.join(tmpDir, ".cache", "index.json"), "{bad json", "utf-8");
    core._invalidateCache();
    const st = core.status();
    assert.strictEqual(st.cache, "corrupted");
    assert.ok(st.version);
  });

  it("handles corrupted state.json without crashing", () => {
    const core = setupEnv();
    const pages = { "A": { category: "主题" } };
    writeIndex(core, tmpDir, makeIndex(pages));
    // Corrupt state file
    fs.writeFileSync(path.join(tmpDir, ".cache", "state.json"), "not json!", "utf-8");
    const st = core.status();
    assert.strictEqual(st.cache, "ready");
    // dirty_log defaults to false from fallback
    assert.strictEqual(st.dirty_log, false);
  });
});

// ---------------------------------------------------------------------------
// appendLog
// ---------------------------------------------------------------------------

describe("appendLog", () => {
  afterEach(cleanupEnv);

  it("creates log file if missing", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    core.appendLog("创建", "TestPage", { mode: "主题" });
    const logPath = path.join(tmpDir, ".cache", "日志.md");
    assert.ok(fs.existsSync(logPath));
    const content = fs.readFileSync(logPath, "utf-8");
    assert.ok(content.includes("创建"));
    assert.ok(content.includes("TestPage"));
  });

  it("appends to existing log", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const logPath = path.join(tmpDir, ".cache", "日志.md");
    fs.writeFileSync(logPath, "# 日志\n\nprevious content\n", "utf-8");
    core.appendLog("更新", "Page2", {});
    const content = fs.readFileSync(logPath, "utf-8");
    assert.ok(content.includes("previous content"));
    assert.ok(content.includes("Page2"));
  });

  it("marks dirty_log in state", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    core.appendLog("创建", "X", {});
    const stateFile = path.join(tmpDir, ".cache", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    assert.strictEqual(state.dirty_log, true);
  });
});

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

describe("lint", () => {
  afterEach(cleanupEnv);

  it("returns ok=true when no issues", () => {
    const core = setupEnv();
    // Create a minimal valid setup with no cross-ref requirements
    writeIndex(core, tmpDir, makeIndex({}));
    const result = core.lint();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.issues.length, 0);
  });

  it("reports orphan pages", () => {
    const core = setupEnv();
    const pages = {
      "Orphan": { category: "主题", obj_token: "ot1", url: "" },
    };
    writeIndex(core, tmpDir, makeIndex(pages));
    // Write empty cached content (no refs to Orphan from any page)
    const cachePath = core.docCachePath("Orphan");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "# Orphan Page\nSome content", "utf-8");

    const result = core.lint();
    const orphanIssues = result.issues.filter((i) => i.type === "孤立");
    assert.ok(orphanIssues.length > 0);
  });

  it("returns stats with page counts", () => {
    const core = setupEnv();
    const pages = {
      "A": { category: "主题", obj_token: "ot1" },
      "B": { category: "来源", obj_token: "ot2" },
    };
    writeIndex(core, tmpDir, makeIndex(pages));
    const result = core.lint();
    assert.strictEqual(result.stats.total, 2);
  });
});

// ---------------------------------------------------------------------------
// _checkWritePermission (tested via create)
// ---------------------------------------------------------------------------

describe("write permission check", () => {
  afterEach(cleanupEnv);

  it("blocks write in read mode", () => {
    const core = setupEnv();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const configPath = path.join(home, ".feishu-wiki-config.json");
    const existed = fs.existsSync(configPath);
    let origContent;
    if (existed) origContent = fs.readFileSync(configPath, "utf-8");

    try {
      fs.writeFileSync(configPath, JSON.stringify({ write_enabled: false }));
      writeIndex(core, tmpDir, makeIndex({}, { "主题": { node_token: "nt_t", obj_token: "ot_t" } }));
      assert.throws(
        () => core.create("主题", "NewPage", "content"),
        (e) => e.message.includes("学习模式")
      );
    } finally {
      if (existed) fs.writeFileSync(configPath, origContent);
      else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    }
  });
});

// ---------------------------------------------------------------------------
// QA logging enhancements
// ---------------------------------------------------------------------------

// Helper: set up env with QA logging enabled and capture QA events via lark.run mock
function setupEnvWithQaCapture() {
  const core = setupEnv();
  // QA events go to .cache/qa-events.ndjson (NDJSON queue).
  // Read them lazily via a proxy array so tests can inspect after operations.
  const qaQueueFile = path.join(tmpDir, ".cache", "qa-events.ndjson");
  const qaEvents = new Proxy([], {
    get(target, prop) {
      // Re-read from file on every access to stay up-to-date
      if (prop === "filter" || prop === "length" || prop === Symbol.iterator) {
        try {
          const lines = fs.readFileSync(qaQueueFile, "utf-8").split("\n").filter(Boolean);
          target.length = 0;
          for (const line of lines) {
            try { target.push(JSON.parse(line)); } catch { /* skip */ }
          }
        } catch { /* file may not exist yet */ }
      }
      return target[prop];
    },
  });
  return { core, qaEvents };
}

describe("QA logging: sequence_number", () => {
  afterEach(cleanupEnv);

  it("increments across multiple find calls", () => {
    const { core, qaEvents } = setupEnvWithQaCapture();
    const pages = {
      "PageA": { category: "主题", obj_token: "ot1", url: "" },
      "PageB": { category: "来源", obj_token: "ot2", url: "" },
    };
    writeIndex(core, tmpDir, makeIndex(pages));

    core.find("PageA");
    core.find("PageB");
    core.find("NonExistent");

    // Filter to call:find events only (warmup from writeIndex also generates events)
    const findEvents = qaEvents.filter((e) => e.event_type === "call:find");
    assert.ok(findEvents.length >= 3, "expected at least 3 find events");

    // sequence_numbers should be strictly increasing
    for (let i = 1; i < findEvents.length; i++) {
      assert.ok(
        findEvents[i].sequence_number > findEvents[i - 1].sequence_number,
        "sequence_number should strictly increase"
      );
    }
    // All should be positive integers
    for (const e of findEvents) {
      assert.ok(typeof e.sequence_number === "number");
      assert.ok(e.sequence_number > 0);
    }
  });
});

describe("QA logging: latency_ms", () => {
  afterEach(cleanupEnv);

  it("is present and >= 0 for find", () => {
    const { core, qaEvents } = setupEnvWithQaCapture();
    writeIndex(core, tmpDir, makeIndex({ "X": { category: "主题", obj_token: "ot1", url: "" } }));
    core.find("X");
    const findEvents = qaEvents.filter((e) => e.event_type === "call:find");
    const last = findEvents[findEvents.length - 1];
    assert.ok(typeof last.latency_ms === "number");
    assert.ok(last.latency_ms >= 0);
  });

  it("is present and >= 0 for fetch", () => {
    const { core, qaEvents } = setupEnvWithQaCapture();
    const pages = {
      "FetchPage": { category: "主题", obj_token: "ot1", obj_edit_time: "t1", url: "" },
    };
    writeIndex(core, tmpDir, makeIndex(pages));

    // Set up cached content
    const cachePath = core.docCachePath("FetchPage");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "# Content", "utf-8");
    const stateFile = path.join(tmpDir, ".cache", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    state.cached_edit_times = { "FetchPage": "t1" };
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf-8");

    core.fetch("FetchPage");
    const fetchEvents = qaEvents.filter((e) => e.event_type === "call:fetch");
    const last = fetchEvents[fetchEvents.length - 1];
    assert.ok(typeof last.latency_ms === "number");
    assert.ok(last.latency_ms >= 0);
  });
});

describe("QA logging: outcome", () => {
  afterEach(cleanupEnv);

  it("reports success for exact find match", () => {
    const { core, qaEvents } = setupEnvWithQaCapture();
    writeIndex(core, tmpDir, makeIndex({ "Exact": { category: "主题", obj_token: "ot1", url: "" } }));
    core.find("Exact");
    const findEvents = qaEvents.filter((e) => e.event_type === "call:find" && e.input === "Exact");
    assert.strictEqual(findEvents[findEvents.length - 1].outcome, "success");
  });

  it("reports partial for fuzzy find match", () => {
    const { core, qaEvents } = setupEnvWithQaCapture();
    writeIndex(core, tmpDir, makeIndex({ "检索增强生成（RAG）": { category: "主题", obj_token: "ot1", url: "" } }));
    core.find("RAG");
    const findEvents = qaEvents.filter((e) => e.event_type === "call:find" && e.input === "RAG");
    assert.strictEqual(findEvents[findEvents.length - 1].outcome, "partial");
  });

  it("reports not_found when no match", () => {
    const { core, qaEvents } = setupEnvWithQaCapture();
    writeIndex(core, tmpDir, makeIndex({}));
    core.find("Ghost");
    const findEvents = qaEvents.filter((e) => e.event_type === "call:find" && e.input === "Ghost");
    const last = findEvents[findEvents.length - 1];
    assert.strictEqual(last.outcome, "not_found");
    assert.strictEqual(last.error_type, "not_found");
  });

  it("reports cached for fetch from cache", () => {
    const { core, qaEvents } = setupEnvWithQaCapture();
    writeIndex(core, tmpDir, makeIndex({ "CachedPage": { category: "主题", obj_token: "ot1", obj_edit_time: "t1", url: "" } }));

    const cachePath = core.docCachePath("CachedPage");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "cached content", "utf-8");
    const stateFile = path.join(tmpDir, ".cache", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    state.cached_edit_times = { "CachedPage": "t1" };
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf-8");

    core.fetch("CachedPage");
    const fetchEvents = qaEvents.filter((e) => e.event_type === "call:fetch" && e.input === "CachedPage");
    assert.strictEqual(fetchEvents[fetchEvents.length - 1].outcome, "cached");
  });

  it("reports success for fresh fetch", () => {
    const { core, qaEvents } = setupEnvWithQaCapture();
    const mockLark = require.cache[LARK_PATH].exports;
    mockLark.fetchDocMarkdown = () => "# Fresh content";

    writeIndex(core, tmpDir, makeIndex({ "FreshPage": { category: "主题", obj_token: "ot1", obj_edit_time: "t1", url: "" } }));
    core.fetch("FreshPage");
    const fetchEvents = qaEvents.filter((e) => e.event_type === "call:fetch" && e.input === "FreshPage");
    assert.strictEqual(fetchEvents[fetchEvents.length - 1].outcome, "success");
  });
});

describe("QA logging: payload_size_bytes", () => {
  afterEach(cleanupEnv);

  it("measures byte size in fetch", () => {
    const { core, qaEvents } = setupEnvWithQaCapture();
    const content = "# Hello 你好世界";
    const mockLark = require.cache[LARK_PATH].exports;
    mockLark.fetchDocMarkdown = () => content;

    writeIndex(core, tmpDir, makeIndex({ "SizePage": { category: "主题", obj_token: "ot1", obj_edit_time: "t1", url: "" } }));
    core.fetch("SizePage");
    const fetchEvents = qaEvents.filter((e) => e.event_type === "call:fetch" && e.input === "SizePage");
    const last = fetchEvents[fetchEvents.length - 1];
    assert.strictEqual(last.payload_size_bytes, Buffer.byteLength(content, "utf-8"));
  });
});

describe("QA logging: permission denial", () => {
  afterEach(cleanupEnv);

  it("logs denied:write event when write is disabled", () => {
    const { core, qaEvents } = setupEnvWithQaCapture();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const configPath = path.join(home, ".feishu-wiki-config.json");
    const existed = fs.existsSync(configPath);
    let origContent;
    if (existed) origContent = fs.readFileSync(configPath, "utf-8");

    try {
      fs.writeFileSync(configPath, JSON.stringify({ write_enabled: false }));
      writeIndex(core, tmpDir, makeIndex({}, { "主题": { node_token: "nt_t", obj_token: "ot_t" } }));

      assert.throws(
        () => core.create("主题", "BlockedPage", "content"),
        (e) => e.message.includes("学习模式")
      );

      const deniedEvents = qaEvents.filter((e) => e.event_type === "denied:write");
      assert.ok(deniedEvents.length >= 1, "expected at least one denied:write event");
      const last = deniedEvents[deniedEvents.length - 1];
      assert.strictEqual(last.outcome, "denied");
      assert.strictEqual(last.error_type, "permission_denied");
      assert.strictEqual(last.input, "BlockedPage");
    } finally {
      if (existed) fs.writeFileSync(configPath, origContent);
      else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    }
  });
});
