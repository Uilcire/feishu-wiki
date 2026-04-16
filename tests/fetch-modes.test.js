/**
 * fetch-modes.test.js — tests for fetchHead, fetchSection, fetchExcerpt
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-modes-test-"));
  origCwd = process.cwd();
  process.chdir(tmpDir);
  origStderrWrite = process.stderr.write;
  process.stderr.write = () => true;

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
  // Overwrite with actual test index and invalidate in-memory cache
  fs.writeFileSync(path.join(cacheDir, "index.json"), JSON.stringify(index), "utf-8");
  fs.writeFileSync(
    path.join(cacheDir, "state.json"),
    JSON.stringify({ dirty_pages: [], dirty_log: false, cached_edit_times: {} }),
    "utf-8"
  );
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
      "\u65e5\u5fd7": { obj_token: "ot_log", node_token: "nt_log", url: "" },
    },
  };
}

// Helper to set up a page with cached content
function setupPage(core, title, pageInfo, content) {
  const pages = {};
  pages[title] = pageInfo;
  writeIndex(core, tmpDir, makeIndex(pages));

  const cachePath = core.docCachePath(title);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, content, "utf-8");

  // Set cached_edit_times so fetch() uses cache
  const stateFile = path.join(tmpDir, ".cache", "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  state.cached_edit_times = {};
  state.cached_edit_times[title] = pageInfo.obj_edit_time || "";
  fs.writeFileSync(stateFile, JSON.stringify(state), "utf-8");
}

const SAMPLE_MD = [
  "# RAG",
  "",
  "检索增强生成技术概述。",
  "",
  "## 概述",
  "",
  "RAG 是一种结合检索与生成的技术。",
  "它可以提升 LLM 的准确性。",
  "",
  "## 核心思想",
  "",
  "核心在于先检索再生成。",
  "通过外部知识库增强模型能力。",
  "这是一种重要的 AI 技术。",
  "",
  "## 关键事实",
  "",
  "- 2020 年提出",
  "- Facebook AI Research",
  "- 开源实现众多",
  "",
  "## 相关主题",
  "",
  "参见向量数据库和嵌入技术。",
  "",
  "## 来源",
  "",
  "原始论文链接。",
].join("\n");

const PAGE_INFO = {
  category: "主题",
  obj_token: "ot_rag",
  node_token: "nt_rag",
  obj_edit_time: "2026-04-15T10:00:00Z",
  url: "https://bytedance.larkoffice.com/wiki/nt_rag",
  summary: "检索增强生成技术...",
};

// ---------------------------------------------------------------------------
// fetchHead
// ---------------------------------------------------------------------------

describe("fetchHead", () => {
  afterEach(cleanupEnv);

  it("returns correct metadata with sections list", () => {
    const core = setupEnv();
    setupPage(core, "RAG", PAGE_INFO, SAMPLE_MD);

    const head = core.fetchHead("RAG");
    assert.strictEqual(head.title, "RAG");
    assert.strictEqual(head.category, "主题");
    assert.strictEqual(head.summary, "检索增强生成技术...");
    assert.strictEqual(head.obj_edit_time, "2026-04-15T10:00:00Z");
    assert.strictEqual(head.deprecated, false);
    assert.strictEqual(head.url, "https://bytedance.larkoffice.com/wiki/nt_rag");
    assert.deepStrictEqual(head.sections, ["概述", "核心思想", "关键事实", "相关主题", "来源"]);
  });

  it("combines with --fresh flag", () => {
    const core = setupEnv();
    const info = { ...PAGE_INFO, obj_edit_time: "old" };
    setupPage(core, "RAG", info, SAMPLE_MD);

    // Mock fetchDocMarkdown to return updated content
    const mockLark = require.cache[LARK_PATH].exports;
    mockLark.fetchDocMarkdown = () => "# RAG\n\n## 新章节\n\n内容";

    const head = core.fetchHead("RAG", { fresh: true });
    assert.deepStrictEqual(head.sections, ["新章节"]);
  });

  it("reports deprecated pages correctly", () => {
    const core = setupEnv();
    const info = { ...PAGE_INFO, deprecated: true };
    // Use includeDeprecated-compatible approach: fetchHead calls find internally
    const pages = { "OldPage": info };
    writeIndex(core, tmpDir, makeIndex(pages));

    const cachePath = core.docCachePath("OldPage");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "# Old\n\n## Section1\ncontent", "utf-8");

    const stateFile = path.join(tmpDir, ".cache", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    state.cached_edit_times = { "OldPage": "2026-04-15T10:00:00Z" };
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf-8");

    // fetchHead uses find() which excludes deprecated by default,
    // so we need to pass the title that exists in the index directly
    // The fetch function will find it through exact match on index.pages
    const head = core.fetchHead("OldPage");
    assert.strictEqual(head.deprecated, true);
  });
});

// ---------------------------------------------------------------------------
// fetchSection
// ---------------------------------------------------------------------------

describe("fetchSection", () => {
  afterEach(cleanupEnv);

  it("returns correct section content", () => {
    const core = setupEnv();
    setupPage(core, "RAG", PAGE_INFO, SAMPLE_MD);

    const section = core.fetchSection("RAG", "核心思想");
    assert.ok(section.startsWith("## 核心思想"));
    assert.ok(section.includes("核心在于先检索再生成"));
    assert.ok(section.includes("通过外部知识库增强模型能力"));
    // Should NOT include content from other sections
    assert.ok(!section.includes("关键事实"));
    assert.ok(!section.includes("2020 年提出"));
  });

  it("supports partial match (case-insensitive)", () => {
    const core = setupEnv();
    setupPage(core, "RAG", PAGE_INFO, SAMPLE_MD);

    const section = core.fetchSection("RAG", "核心");
    assert.ok(section.startsWith("## 核心思想"));
    assert.ok(section.includes("核心在于先检索再生成"));
  });

  it("fails gracefully with nonexistent section", () => {
    const core = setupEnv();
    setupPage(core, "RAG", PAGE_INFO, SAMPLE_MD);

    assert.throws(
      () => core.fetchSection("RAG", "不存在的章节"),
      (e) => {
        assert.ok(e.message.includes("找不到章节"));
        assert.ok(e.message.includes("概述"));
        assert.ok(e.message.includes("核心思想"));
        return true;
      }
    );
  });

  it("returns last section to end of file", () => {
    const core = setupEnv();
    setupPage(core, "RAG", PAGE_INFO, SAMPLE_MD);

    const section = core.fetchSection("RAG", "来源");
    assert.ok(section.startsWith("## 来源"));
    assert.ok(section.includes("原始论文链接"));
  });
});

// ---------------------------------------------------------------------------
// fetchExcerpt
// ---------------------------------------------------------------------------

describe("fetchExcerpt", () => {
  afterEach(cleanupEnv);

  it("returns correct context with line numbers", () => {
    const core = setupEnv();
    setupPage(core, "RAG", PAGE_INFO, SAMPLE_MD);

    const excerpt = core.fetchExcerpt("RAG", "检索");
    // Should contain line numbers
    assert.ok(/\d+:/.test(excerpt));
    // Should contain the matching lines (marked with >)
    assert.ok(excerpt.includes(">"));
    // Should contain the keyword
    assert.ok(excerpt.includes("检索"));
  });

  it("adjusts window size with --window option", () => {
    const core = setupEnv();
    setupPage(core, "RAG", PAGE_INFO, SAMPLE_MD);

    const smallWindow = core.fetchExcerpt("RAG", "Facebook", { window: 1 });
    const largeWindow = core.fetchExcerpt("RAG", "Facebook", { window: 10 });

    // Larger window should have more lines
    const smallLines = smallWindow.split("\n").length;
    const largeLines = largeWindow.split("\n").length;
    assert.ok(largeLines >= smallLines, `large(${largeLines}) should >= small(${smallLines})`);
  });

  it("throws when keyword not found", () => {
    const core = setupEnv();
    setupPage(core, "RAG", PAGE_INFO, SAMPLE_MD);

    assert.throws(
      () => core.fetchExcerpt("RAG", "完全不存在的关键词xyz"),
      (e) => e.message.includes("未找到关键词")
    );
  });

  it("separates multiple non-overlapping matches with ---", () => {
    const core = setupEnv();
    // Create content with matches far apart
    const content = [
      "line 1: keyword here",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
      "line 11",
      "line 12",
      "line 13",
      "line 14",
      "line 15",
      "line 16",
      "line 17",
      "line 18",
      "line 19",
      "line 20: keyword again",
    ].join("\n");
    setupPage(core, "RAG", PAGE_INFO, content);

    const excerpt = core.fetchExcerpt("RAG", "keyword", { window: 2 });
    assert.ok(excerpt.includes("---"), "should separate non-overlapping matches with ---");
  });

  it("is case-insensitive", () => {
    const core = setupEnv();
    setupPage(core, "RAG", PAGE_INFO, SAMPLE_MD);

    // "facebook" lowercase should match "Facebook" in the content
    const excerpt = core.fetchExcerpt("RAG", "facebook");
    assert.ok(excerpt.includes("Facebook"));
  });
});

// ---------------------------------------------------------------------------
// default fetch still works
// ---------------------------------------------------------------------------

describe("default fetch unchanged", () => {
  afterEach(cleanupEnv);

  it("returns full content without any mode flags", () => {
    const core = setupEnv();
    setupPage(core, "RAG", PAGE_INFO, SAMPLE_MD);

    const content = core.fetch("RAG");
    assert.strictEqual(content, SAMPLE_MD);
  });
});
