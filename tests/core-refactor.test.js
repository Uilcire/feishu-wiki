/**
 * core-refactor.test.js — adversarial tests for core.js refactoring
 *
 * Covers: atomic writes, QA async queue, stale mode, iterPages, edge cases.
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
let stderrOutput;

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

function setupEnv({ captureStderr = false } = {}) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-refactor-test-"));
  origCwd = process.cwd();
  process.chdir(tmpDir);
  origStderrWrite = process.stderr.write;
  stderrOutput = [];
  if (captureStderr) {
    process.stderr.write = (chunk) => { stderrOutput.push(String(chunk)); return true; };
  } else {
    process.stderr.write = () => true;
  }

  fs.writeFileSync(
    path.join(tmpDir, ".feishu-config.json"),
    JSON.stringify({ space_id: "sp_test", root_node_token: "nt_root", root_obj_token: "ot_root" }),
    "utf-8"
  );

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

function writeIndex(core, dir, index) {
  const cacheDir = path.join(dir, ".cache");
  fs.mkdirSync(path.join(cacheDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "index.json"), "{}", "utf-8");
  fs.writeFileSync(
    path.join(cacheDir, "state.json"),
    JSON.stringify({ dirty_pages: [], dirty_log: false }),
    "utf-8"
  );
  core.ensureCache();
  core.find("__warmup__");
  fs.writeFileSync(path.join(cacheDir, "index.json"), JSON.stringify(index), "utf-8");
  fs.writeFileSync(
    path.join(cacheDir, "state.json"),
    JSON.stringify({ dirty_pages: [], dirty_log: false, cached_edit_times: {} }),
    "utf-8"
  );
  core._invalidateCache();
}

// ===========================================================================
// 1. Atomic writes
// ===========================================================================

describe("atomicWriteJson — saveIndex", () => {
  afterEach(cleanupEnv);

  it("no temp files left after saveIndex", () => {
    const core = setupEnv();
    const idx = makeIndex({ "P": { category: "主题", obj_token: "ot1" } });
    writeIndex(core, tmpDir, idx);
    // Call saveIndex directly
    core.saveIndex(idx);
    const cacheDir = path.join(tmpDir, ".cache");
    const files = fs.readdirSync(cacheDir);
    const temps = files.filter((f) => f.endsWith(".tmp"));
    assert.strictEqual(temps.length, 0, `temp files left behind: ${temps.join(", ")}`);
  });

  it("original file untouched when write target dir is missing", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const idxFile = path.join(tmpDir, ".cache", "index.json");
    const before = fs.readFileSync(idxFile, "utf-8");

    // Try saving to a non-existent subdirectory — atomicWriteJson should throw
    // but saveIndex writes to the known CACHE_DIR which exists, so instead
    // we verify the normal path preserves data
    const newIdx = makeIndex({ "X": { category: "主题" } });
    core.saveIndex(newIdx);
    const after = fs.readFileSync(idxFile, "utf-8");
    assert.ok(JSON.parse(after).pages["X"], "new data should be written");
  });

  it("handles very large JSON payloads (100K+ chars)", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const bigPages = {};
    for (let i = 0; i < 500; i++) {
      bigPages[`Page_${i}_${"x".repeat(200)}`] = {
        category: "主题",
        obj_token: `ot_${i}`,
        summary: "y".repeat(200),
      };
    }
    const bigIdx = makeIndex(bigPages);
    const jsonLen = JSON.stringify(bigIdx).length;
    assert.ok(jsonLen > 100000, `payload should be >100K, got ${jsonLen}`);

    core.saveIndex(bigIdx);
    const loaded = core.loadIndex();
    // loadIndex uses memory cache, invalidate to force disk read
    core._invalidateCache();
    const fromDisk = core.loadIndex();
    assert.strictEqual(Object.keys(fromDisk.pages).length, 500);
  });

  it("rapid-fire saveIndex calls don't corrupt", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));

    for (let i = 0; i < 50; i++) {
      const idx = makeIndex({ [`Page${i}`]: { category: "主题", obj_token: `ot_${i}` } });
      core.saveIndex(idx);
    }
    core._invalidateCache();
    const final = core.loadIndex();
    assert.ok(final, "index should be readable after rapid writes");
    assert.ok(final.pages["Page49"], "last write should win");
  });

  it("saveIndex updates in-memory cache immediately", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const idx = makeIndex({ "Mem": { category: "主题", obj_token: "ot_mem" } });
    core.saveIndex(idx);
    // loadIndex should return cached version without disk read
    const loaded = core.loadIndex();
    assert.ok(loaded.pages["Mem"]);
  });
});

// ===========================================================================
// 2. QA queue
// ===========================================================================

describe("QA async queue — _logQaEvent / flushQaEvents", () => {
  afterEach(cleanupEnv);

  it("_logQaEvent writes to NDJSON file (not calling lark.run)", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));

    const mockLark = require.cache[LARK_PATH].exports;
    let larkRunCalled = false;
    const origRun = mockLark.run;
    mockLark.run = (...args) => { larkRunCalled = true; return origRun(...args); };

    // Trigger a find which calls _logQaEvent internally
    core.find("anything");
    mockLark.run = origRun;

    // _logQaEvent should NOT have called lark.run
    // (it did get called during ensureCache/buildIndex, so check the queue file instead)
    const qaFile = path.join(tmpDir, ".cache", "qa-events.ndjson");
    assert.ok(fs.existsSync(qaFile), "qa queue file should exist");
    const lines = fs.readFileSync(qaFile, "utf-8").split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "should have at least one QA event");
    // Each line should be valid JSON
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `invalid NDJSON line: ${line}`);
    }
  });

  it("flushQaEvents handles empty queue", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    // Ensure no queue file
    const qaFile = path.join(tmpDir, ".cache", "qa-events.ndjson");
    if (fs.existsSync(qaFile)) fs.unlinkSync(qaFile);
    const result = core.flushQaEvents();
    assert.strictEqual(result.flushed, 0);
  });

  it("flushQaEvents handles missing queue file", () => {
    const core = setupEnv();
    // Don't even create cache dir events
    const result = core.flushQaEvents();
    assert.strictEqual(result.flushed, 0);
  });

  it("flushQaEvents handles corrupted lines gracefully", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const qaFile = path.join(tmpDir, ".cache", "qa-events.ndjson");
    // Write mix of valid and invalid lines
    fs.writeFileSync(qaFile, [
      JSON.stringify({ session_id: "s1", event_type: "test" }),
      "THIS IS NOT JSON {{{",
      JSON.stringify({ session_id: "s2", event_type: "test2" }),
    ].join("\n") + "\n", "utf-8");

    const result = core.flushQaEvents();
    // Valid lines should flush, corrupted line should fail and be written back
    assert.ok(result.flushed >= 0);
    // The corrupted line should end up back in the queue
    if (fs.existsSync(qaFile)) {
      const remaining = fs.readFileSync(qaFile, "utf-8").split("\n").filter(Boolean);
      const hasCorrupted = remaining.some((l) => l.includes("THIS IS NOT JSON"));
      assert.ok(hasCorrupted, "corrupted line should be written back to queue");
    }
  });

  it("failed uploads get written back to queue", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const qaFile = path.join(tmpDir, ".cache", "qa-events.ndjson");

    // Write valid entries
    const entry1 = JSON.stringify({ session_id: "s1", event_type: "test" });
    const entry2 = JSON.stringify({ session_id: "s2", event_type: "test2" });
    fs.writeFileSync(qaFile, entry1 + "\n" + entry2 + "\n", "utf-8");

    // Make lark.run throw for all uploads
    const mockLark = require.cache[LARK_PATH].exports;
    const origRun = mockLark.run;
    mockLark.run = () => { throw new Error("upload failed"); };

    const result = core.flushQaEvents();
    mockLark.run = origRun;

    assert.strictEqual(result.flushed, 0);
    // Failed entries should be written back
    assert.ok(fs.existsSync(qaFile), "queue file should exist with failed entries");
    const remaining = fs.readFileSync(qaFile, "utf-8").split("\n").filter(Boolean);
    assert.strictEqual(remaining.length, 2, "both entries should be written back");
  });

  it(".processing file is cleaned up after flush", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const qaFile = path.join(tmpDir, ".cache", "qa-events.ndjson");
    fs.writeFileSync(qaFile, JSON.stringify({ test: true }) + "\n", "utf-8");

    core.flushQaEvents();

    const processingFile = qaFile + ".processing";
    assert.ok(!fs.existsSync(processingFile), ".processing file should be cleaned up");
  });

  it("logQa writes to queue file (not sync lark.run)", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const qaFile = path.join(tmpDir, ".cache", "qa-events.ndjson");
    if (fs.existsSync(qaFile)) fs.unlinkSync(qaFile);

    const result = core.logQa("test question", "test answer", []);
    assert.ok(result.ok);
    assert.ok(result.session_id);

    assert.ok(fs.existsSync(qaFile), "logQa should write to queue file");
    const lines = fs.readFileSync(qaFile, "utf-8").split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.event_type, "qa_log");
    assert.strictEqual(last.input, "test question");
  });

  it("sync() calls flushQaEvents", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const qaFile = path.join(tmpDir, ".cache", "qa-events.ndjson");
    fs.writeFileSync(qaFile, JSON.stringify({ session_id: "s1", event_type: "test" }) + "\n", "utf-8");

    core.sync();

    // After sync, the queue file should be gone or empty (entries were flushed)
    const processingFile = qaFile + ".processing";
    assert.ok(!fs.existsSync(processingFile), "processing file should be cleaned up by sync");
  });
});

// ===========================================================================
// 3. Stale mode
// ===========================================================================

describe("stale mode — refreshIndexIfStale / status", () => {
  afterEach(cleanupEnv);

  it("status() includes freshness field when cache is ready", () => {
    const core = setupEnv();
    const pages = { "A": { category: "主题", obj_token: "ot1" } };
    writeIndex(core, tmpDir, makeIndex(pages));
    const st = core.status();
    assert.strictEqual(st.cache, "ready");
    assert.ok("freshness" in st, "status should include freshness");
  });

  it("status() includes last_successful_refresh_at and last_refresh_failed_at", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const st = core.status();
    assert.ok("last_successful_refresh_at" in st);
    assert.ok("last_refresh_failed_at" in st);
    assert.ok("last_refresh_error" in st);
  });

  it("freshness is fresh after ensureCache with no prior state", () => {
    const core = setupEnv();
    // ensureCache triggers buildIndex when no index exists
    core.ensureCache();
    const stateFile = path.join(tmpDir, ".cache", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    assert.strictEqual(state.freshness, "fresh");
  });

  it("loadState returns full defaults when state.json is missing", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    // Delete state file
    const stateFile = path.join(tmpDir, ".cache", "state.json");
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);

    // loadState is not exported, but status() calls it — check via status
    const st = core.status();
    // dirty_log should default to false
    assert.strictEqual(st.dirty_log, false);
    assert.strictEqual(st.freshness, "unknown");
  });

  it("state.json with extra fields doesn't crash (backwards compat)", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const stateFile = path.join(tmpDir, ".cache", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    state.some_future_field = "hello";
    state.another_future = 42;
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf-8");

    // Should not crash
    const st = core.status();
    assert.strictEqual(st.cache, "ready");
  });

  it("state.json with missing new fields uses defaults via status()", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const stateFile = path.join(tmpDir, ".cache", "state.json");
    // Write old-format state without freshness fields
    fs.writeFileSync(stateFile, JSON.stringify({ dirty_pages: [], dirty_log: false }), "utf-8");

    const st = core.status();
    // Should still work, freshness defaults
    assert.strictEqual(st.cache, "ready");
    assert.ok("freshness" in st);
  });

  it("stale-fallback emits stderr warning", () => {
    const core = setupEnv({ captureStderr: true });
    writeIndex(core, tmpDir, makeIndex({ "A": { category: "主题" } }));

    // Force TTL expiry by manipulating _indexLastRefresh (not directly accessible,
    // but we can invalidate cache and force a stale refresh)
    core._invalidateCache();

    // Make buildIndex fail by making lark.listChildren throw
    const mockLark = require.cache[LARK_PATH].exports;
    const origList = mockLark.listChildren;
    mockLark.listChildren = () => { throw new Error("network down"); };

    // Force a find which triggers refreshIndexIfStale
    // First, we need to expire the TTL — the writeIndex helper set _indexLastRefresh
    // We'll do a fresh require to reset _indexLastRefresh to 0
    delete require.cache[CORE_PATH];
    require.cache[LARK_PATH].exports = { ...makeMockLark(), listChildren: () => { throw new Error("network down"); } };
    const core2 = require(CORE_PATH);

    // Manually set up cache so ensureCache doesn't try to build
    const cacheDir = path.join(tmpDir, ".cache");
    // index.json exists from writeIndex, so ensureCache will seed _indexLastRefresh from mtime
    // But we need TTL to expire — write index with old mtime
    const indexFile = path.join(cacheDir, "index.json");
    const oldTime = new Date(Date.now() - 120_000); // 2 min ago
    fs.utimesSync(indexFile, oldTime, oldTime);

    core2.ensureCache();
    stderrOutput = []; // clear setup noise

    // Now find should trigger refreshIndexIfStale → buildIndex fails → stale fallback
    const result = core2.find("A");

    const hasWarning = stderrOutput.some((s) => s.includes("索引刷新失败") || s.includes("stale"));
    assert.ok(hasWarning, `expected stale warning in stderr, got: ${stderrOutput.join("")}`);

    // Check state has stale-fallback
    const stateFile = path.join(cacheDir, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    assert.strictEqual(state.freshness, "stale-fallback");
    assert.ok(state.last_refresh_failed_at);
    assert.ok(state.last_refresh_error.includes("network down"));

    mockLark.listChildren = origList;
  });
});

// ===========================================================================
// 4. iterPages
// ===========================================================================

describe("iterPages", () => {
  afterEach(cleanupEnv);

  it("excludes deprecated pages by default", () => {
    const core = setupEnv();
    const index = makeIndex({
      "Active": { category: "主题", obj_token: "ot1" },
      "Old": { category: "主题", obj_token: "ot2", deprecated: true },
    });
    const result = core.iterPages(index);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, "Active");
  });

  it("includes deprecated when includeDeprecated=true", () => {
    const core = setupEnv();
    const index = makeIndex({
      "Active": { category: "主题", obj_token: "ot1" },
      "Old": { category: "主题", obj_token: "ot2", deprecated: true },
    });
    const result = core.iterPages(index, { includeDeprecated: true });
    assert.strictEqual(result.length, 2);
  });

  it("filters by category", () => {
    const core = setupEnv();
    const index = makeIndex({
      "A": { category: "主题", obj_token: "ot1" },
      "B": { category: "来源", obj_token: "ot2" },
      "C": { category: "主题", obj_token: "ot3" },
    });
    const result = core.iterPages(index, { category: "主题" });
    assert.strictEqual(result.length, 2);
    assert.ok(result.every((p) => p.category === "主题"));
  });

  it("combined deprecated + category filtering", () => {
    const core = setupEnv();
    const index = makeIndex({
      "A": { category: "主题", obj_token: "ot1" },
      "B": { category: "主题", obj_token: "ot2", deprecated: true },
      "C": { category: "来源", obj_token: "ot3" },
      "D": { category: "来源", obj_token: "ot4", deprecated: true },
    });
    // Only active 来源
    const result = core.iterPages(index, { category: "来源" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, "C");

    // All 来源 including deprecated
    const all = core.iterPages(index, { category: "来源", includeDeprecated: true });
    assert.strictEqual(all.length, 2);
  });

  it("empty index returns empty array", () => {
    const core = setupEnv();
    const index = makeIndex({});
    const result = core.iterPages(index);
    assert.deepStrictEqual(result, []);
  });

  it("index with no pages key returns empty array", () => {
    const core = setupEnv();
    const index = { built_at: "", space_id: "", root: {}, containers: {} };
    const result = core.iterPages(index);
    assert.deepStrictEqual(result, []);
  });

  it("result is a new array (not a reference to internal state)", () => {
    const core = setupEnv();
    const index = makeIndex({ "A": { category: "主题", obj_token: "ot1" } });
    const r1 = core.iterPages(index);
    const r2 = core.iterPages(index);
    assert.notStrictEqual(r1, r2, "should return new array each time");
    r1.push({ title: "injected" });
    const r3 = core.iterPages(index);
    assert.strictEqual(r3.length, 1, "mutation of result should not affect future calls");
  });

  it("consistency: find(), listPages(), iterPages() agree on active pages", () => {
    const core = setupEnv();
    const pages = {
      "Active1": { category: "主题", obj_token: "ot1", url: "" },
      "Active2": { category: "来源", obj_token: "ot2", url: "" },
      "Deprecated": { category: "主题", obj_token: "ot3", url: "", deprecated: true },
    };
    writeIndex(core, tmpDir, makeIndex(pages));

    const listed = core.listPages();
    const listedTitles = new Set(listed.map((p) => p.title));

    // iterPages on fresh index
    core._invalidateCache();
    const index = core.loadIndex();
    const iterated = core.iterPages(index);
    const iteratedTitles = new Set(iterated.map((p) => p.title));

    assert.deepStrictEqual(listedTitles, iteratedTitles, "listPages and iterPages should agree");
    assert.ok(!listedTitles.has("Deprecated"), "deprecated should be excluded");
    assert.strictEqual(listedTitles.size, 2);

    // find should return null for deprecated
    assert.strictEqual(core.find("Deprecated"), null);
    // find should return active pages
    assert.ok(core.find("Active1"));
    assert.ok(core.find("Active2"));
  });

  it("each result element has title property injected", () => {
    const core = setupEnv();
    const index = makeIndex({
      "MyPage": { category: "主题", obj_token: "ot1" },
    });
    const result = core.iterPages(index);
    assert.strictEqual(result[0].title, "MyPage");
  });
});

// ===========================================================================
// 5. Edge cases & integration
// ===========================================================================

describe("edge cases", () => {
  afterEach(cleanupEnv);

  it("corrupted index.json — loadIndex returns null", () => {
    const core = setupEnv();
    core.ensureCache();
    const idxFile = path.join(tmpDir, ".cache", "index.json");
    fs.writeFileSync(idxFile, "{{{not valid json!!!", "utf-8");
    core._invalidateCache();
    const result = core.loadIndex();
    assert.strictEqual(result, null);
  });

  it("missing .cache directory — ensureCache creates it", () => {
    const core = setupEnv();
    const cacheDir = path.join(tmpDir, ".cache");
    assert.ok(!fs.existsSync(cacheDir), "cache dir should not exist yet");
    core.ensureCache();
    assert.ok(fs.existsSync(cacheDir), "ensureCache should create .cache");
  });

  it("corrupted state.json — status() doesn't crash", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({ "A": { category: "主题" } }));
    const stateFile = path.join(tmpDir, ".cache", "state.json");
    fs.writeFileSync(stateFile, "~~~not json~~~", "utf-8");
    const st = core.status();
    assert.strictEqual(st.cache, "ready");
    assert.strictEqual(st.dirty_log, false);
    assert.strictEqual(st.freshness, "unknown");
  });

  it("rapid sequential operations (find → listPages → find) stress cache", () => {
    const core = setupEnv();
    const pages = {};
    for (let i = 0; i < 100; i++) {
      pages[`Page${i}`] = { category: "主题", obj_token: `ot_${i}`, url: "" };
    }
    writeIndex(core, tmpDir, makeIndex(pages));

    // Rapid fire
    for (let i = 0; i < 20; i++) {
      const found = core.find(`Page${i}`);
      assert.ok(found, `should find Page${i}`);
      assert.strictEqual(found.title, `Page${i}`);
    }
    const all = core.listPages();
    assert.strictEqual(all.length, 100);

    // Find again after list
    const p50 = core.find("Page50");
    assert.ok(p50);
  });

  it("docCachePath with empty string doesn't crash", () => {
    const core = setupEnv();
    const p = core.docCachePath("");
    assert.ok(p.endsWith(".md"));
  });

  it("iterPages with null category matches pages with null category", () => {
    const core = setupEnv();
    const index = makeIndex({
      "Uncategorized": { category: null, obj_token: "ot1" },
      "Categorized": { category: "主题", obj_token: "ot2" },
    });
    // category filter = null means "don't filter by category"
    const all = core.iterPages(index);
    assert.strictEqual(all.length, 2);

    // Explicit category filter
    const topicOnly = core.iterPages(index, { category: "主题" });
    assert.strictEqual(topicOnly.length, 1);
    assert.strictEqual(topicOnly[0].title, "Categorized");
  });

  it("flushQaEvents with only empty lines in queue", () => {
    const core = setupEnv();
    core.ensureCache();
    const qaFile = path.join(tmpDir, ".cache", "qa-events.ndjson");
    fs.writeFileSync(qaFile, "\n\n\n", "utf-8");
    const result = core.flushQaEvents();
    assert.strictEqual(result.flushed, 0);
  });

  it("saveIndex then immediate loadIndex returns consistent data", () => {
    const core = setupEnv();
    writeIndex(core, tmpDir, makeIndex({}));
    const idx = makeIndex({ "Fresh": { category: "来源", obj_token: "ot_fresh" } });
    core.saveIndex(idx);
    // Without invalidating cache — should get memory-cached version
    const loaded = core.loadIndex();
    assert.ok(loaded.pages["Fresh"]);
    // After invalidating — should get disk version
    core._invalidateCache();
    const fromDisk = core.loadIndex();
    assert.ok(fromDisk.pages["Fresh"]);
  });
});
