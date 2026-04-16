/**
 * search.test.js — tests for lib/search.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Mock setup — inject mocks into require cache before loading search.js
// ---------------------------------------------------------------------------

const PROJ = path.resolve(__dirname, "..");
const SEARCH_PATH = require.resolve(path.join(PROJ, "lib/search.js"));
const CORE_PATH = require.resolve(path.join(PROJ, "lib/core.js"));
const LARK_PATH = require.resolve(path.join(PROJ, "lib/lark.js"));

let tmpDir;
let mockCore;
let mockLark;

function setup(pages = [], indexPages = {}) {
  // Fresh temp dir for cached docs
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-test-"));
  const docsDir = path.join(tmpDir, "docs");
  fs.mkdirSync(docsDir, { recursive: true });

  mockCore = {
    ensureCache: () => {},
    listPages: ({ category } = {}) => {
      if (category) return pages.filter((p) => p.category === category);
      return pages;
    },
    docCachePath: (title) =>
      path.join(docsDir, title.replace(/[\\/:*?"<>|]/g, "_") + ".md"),
    loadIndex: () => ({
      pages: indexPages,
    }),
    loadWikiTokensFromCloud: () => null,
    lastIndexMeta: { freshness: "cached", data_source: "index" },
  };

  mockLark = {
    run: () => null,
    isSuccess: (r) => Boolean(r) && (r.ok || r.code === 0),
  };

  // Inject mocks
  delete require.cache[SEARCH_PATH];
  require.cache[CORE_PATH] = { id: CORE_PATH, filename: CORE_PATH, loaded: true, exports: mockCore };
  require.cache[LARK_PATH] = { id: LARK_PATH, filename: LARK_PATH, loaded: true, exports: mockLark };

  return require(SEARCH_PATH);
}

function cleanup() {
  delete require.cache[SEARCH_PATH];
  delete require.cache[CORE_PATH];
  delete require.cache[LARK_PATH];
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

describe("grep", () => {
  afterEach(cleanup);

  it("finds pages containing the keyword", () => {
    const pages = [
      { title: "RAG概述", category: "主题" },
      { title: "工具调用", category: "主题" },
    ];
    const search = setup(pages);
    // Write cached content
    fs.writeFileSync(mockCore.docCachePath("RAG概述"), "RAG 是检索增强生成技术\n第二行也提到RAG", "utf-8");
    fs.writeFileSync(mockCore.docCachePath("工具调用"), "工具调用是一种技术", "utf-8");

    const out = search.grep("RAG");
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].title, "RAG概述");
    assert.strictEqual(out.results[0].matches.length, 2);
  });

  it("is case insensitive by default", () => {
    const pages = [{ title: "Test", category: "主题" }];
    const search = setup(pages);
    fs.writeFileSync(mockCore.docCachePath("Test"), "Hello World\nhello again", "utf-8");

    const out = search.grep("hello");
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].matches.length, 2);
  });

  it("filters by category", () => {
    const pages = [
      { title: "Page1", category: "来源" },
      { title: "Page2", category: "主题" },
    ];
    const search = setup(pages);
    fs.writeFileSync(mockCore.docCachePath("Page1"), "keyword here", "utf-8");
    fs.writeFileSync(mockCore.docCachePath("Page2"), "keyword here", "utf-8");

    const out = search.grep("keyword", { category: "来源" });
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].title, "Page1");
  });

  it("supports regex patterns", () => {
    const pages = [{ title: "Doc", category: "主题" }];
    const search = setup(pages);
    fs.writeFileSync(mockCore.docCachePath("Doc"), "foo123bar\nfoo456bar\nbaz", "utf-8");

    const out = search.grep("foo\\d+bar");
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].matches.length, 2);
  });

  it("falls back to escaped literal on invalid regex", () => {
    const pages = [{ title: "Doc", category: "主题" }];
    const search = setup(pages);
    fs.writeFileSync(mockCore.docCachePath("Doc"), "match (unclosed text\nno match here", "utf-8");

    // "(unclosed" is an invalid regex — search.js catches and escapes it
    const out = search.grep("(unclosed");
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].matches.length, 1);
  });

  it("sorts results by match count descending", () => {
    const pages = [
      { title: "Few", category: "主题" },
      { title: "Many", category: "主题" },
    ];
    const search = setup(pages);
    fs.writeFileSync(mockCore.docCachePath("Few"), "hit\n", "utf-8");
    fs.writeFileSync(mockCore.docCachePath("Many"), "hit\nhit\nhit\n", "utf-8");

    const out = search.grep("hit");
    assert.strictEqual(out.results[0].title, "Many");
    assert.strictEqual(out.results[0].matches.length, 3);
    assert.strictEqual(out.results[1].title, "Few");
    assert.strictEqual(out.results[1].matches.length, 1);
  });

  it("skips pages without cached content", () => {
    const pages = [
      { title: "Cached", category: "主题" },
      { title: "NotCached", category: "主题" },
    ];
    const search = setup(pages);
    fs.writeFileSync(mockCore.docCachePath("Cached"), "keyword", "utf-8");
    // NotCached has no file

    const out = search.grep("keyword");
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].title, "Cached");
  });

  it("includes line numbers and truncated text in results", () => {
    const pages = [{ title: "Doc", category: "主题" }];
    const search = setup(pages);
    const longLine = "keyword " + "x".repeat(200);
    fs.writeFileSync(mockCore.docCachePath("Doc"), `first\n${longLine}\nthird`, "utf-8");

    const out = search.grep("keyword");
    assert.strictEqual(out.results[0].matches[0].line, 2);
    assert.ok(out.results[0].matches[0].text.length <= 120);
  });

  it("returns empty results when no matches found", () => {
    const pages = [{ title: "Doc", category: "主题" }];
    const search = setup(pages);
    fs.writeFileSync(mockCore.docCachePath("Doc"), "nothing here", "utf-8");

    const out = search.grep("nonexistent");
    assert.deepStrictEqual(out.results, []);
  });

  it("skips pages with empty cached content", () => {
    const pages = [{ title: "Empty", category: "主题" }];
    const search = setup(pages);
    fs.writeFileSync(mockCore.docCachePath("Empty"), "", "utf-8");

    const out = search.grep("anything");
    assert.deepStrictEqual(out.results, []);
  });

  it("returns coverage object with correct ratio", () => {
    const pages = [
      { title: "Cached1", category: "主题" },
      { title: "Cached2", category: "主题" },
      { title: "NotCached", category: "主题" },
    ];
    const indexPages = {
      "Cached1": { obj_token: "t1" },
      "Cached2": { obj_token: "t2" },
      "NotCached": { obj_token: "t3" },
      "ExtraPage": { obj_token: "t4" },
    };
    const search = setup(pages, indexPages);
    fs.writeFileSync(mockCore.docCachePath("Cached1"), "data", "utf-8");
    fs.writeFileSync(mockCore.docCachePath("Cached2"), "data", "utf-8");
    // NotCached has no file on disk

    const out = search.grep("data");
    assert.strictEqual(out.coverage.cached_docs_scanned, 2);
    assert.strictEqual(out.coverage.total_pages_indexed, 4);
    assert.strictEqual(out.coverage.coverage_ratio, 0.5);
  });

  it("includes freshness and data_source", () => {
    const search = setup([{ title: "Doc", category: "主题" }]);
    fs.writeFileSync(mockCore.docCachePath("Doc"), "word", "utf-8");
    const out = search.grep("word");
    assert.ok(out.freshness);
    assert.strictEqual(out.data_source, "disk_cache");
  });
});

// ---------------------------------------------------------------------------
// searchFeishu
// ---------------------------------------------------------------------------

describe("searchFeishu", () => {
  afterEach(cleanup);

  it("returns wiki-only results by default", () => {
    const wikiPages = {
      "RAG": { obj_token: "tok_rag" },
      "Agent": { obj_token: "tok_agent" },
    };
    const search = setup([], wikiPages);
    mockLark.run = () => ({
      ok: true,
      data: {
        results: [
          {
            title_highlighted: "<h>RAG</h>",
            summary_highlighted: "about <h>RAG</h>",
            entity_type: "docx",
            result_meta: {
              token: "tok_rag",
              url: "https://lark.com/doc/1",
              owner_name: "Alice",
              update_time_iso: "2026-04-01T00:00:00Z",
            },
          },
          {
            title_highlighted: "External Doc",
            summary_highlighted: "not in wiki",
            entity_type: "docx",
            result_meta: {
              token: "tok_external",
              url: "https://lark.com/doc/2",
              owner_name: "Bob",
              update_time_iso: "2026-04-02T00:00:00Z",
            },
          },
        ],
      },
    });

    const out = search.searchFeishu("RAG");
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].title, "RAG");
    assert.strictEqual(out.results[0].is_wiki, true);
  });

  it("returns all docs when allDocs is true", () => {
    const wikiPages = { "RAG": { obj_token: "tok_rag" } };
    const search = setup([], wikiPages);
    mockLark.run = () => ({
      ok: true,
      data: {
        results: [
          {
            title_highlighted: "RAG",
            summary_highlighted: "wiki",
            entity_type: "docx",
            result_meta: { token: "tok_rag", url: "", owner_name: "", update_time_iso: "" },
          },
          {
            title_highlighted: "Other",
            summary_highlighted: "not wiki",
            entity_type: "docx",
            result_meta: { token: "tok_other", url: "", owner_name: "", update_time_iso: "" },
          },
        ],
      },
    });

    const out = search.searchFeishu("RAG", { allDocs: true });
    assert.strictEqual(out.results.length, 2);
    assert.strictEqual(out.results[0].is_wiki, true);
    assert.strictEqual(out.results[1].is_wiki, false);
  });

  it("strips <h> highlight tags from title and summary", () => {
    const search = setup([], { "Test": { obj_token: "tok_1" } });
    mockLark.run = () => ({
      ok: true,
      data: {
        results: [
          {
            title_highlighted: "<h>Test</h> Page",
            summary_highlighted: "A <h>test</h> summary",
            entity_type: "docx",
            result_meta: { token: "tok_1", url: "", owner_name: "", update_time_iso: "" },
          },
        ],
      },
    });

    const out = search.searchFeishu("test");
    assert.strictEqual(out.results[0].title, "Test Page");
    assert.strictEqual(out.results[0].summary, "A test summary");
  });

  it("returns empty results on API failure", () => {
    const search = setup([], {});
    mockLark.run = () => null;

    const out = search.searchFeishu("anything");
    assert.deepStrictEqual(out.results, []);
    assert.strictEqual(out.freshness, "fresh");
    assert.strictEqual(out.data_source, "remote_api");
  });

  it("returns empty results when result is not success", () => {
    const search = setup([], {});
    mockLark.run = () => ({ ok: false });

    const out = search.searchFeishu("anything");
    assert.deepStrictEqual(out.results, []);
  });

  it("result structure has all expected fields", () => {
    const search = setup([], { "Page": { obj_token: "tok_p" } });
    mockLark.run = () => ({
      ok: true,
      data: {
        results: [
          {
            title_highlighted: "Page",
            summary_highlighted: "Summary text",
            entity_type: "docx",
            result_meta: {
              token: "tok_p",
              url: "https://example.com/doc",
              owner_name: "Owner",
              update_time_iso: "2026-01-15T12:00:00Z",
            },
          },
        ],
      },
    });

    const out = search.searchFeishu("Page");
    assert.strictEqual(out.results.length, 1);
    const r = out.results[0];
    assert.strictEqual(r.title, "Page");
    assert.strictEqual(r.summary, "Summary text");
    assert.strictEqual(r.url, "https://example.com/doc");
    assert.strictEqual(r.type, "docx");
    assert.strictEqual(r.owner, "Owner");
    assert.strictEqual(r.updated, "2026-01-15");
    assert.strictEqual(r.token, "tok_p");
    assert.strictEqual(r.is_wiki, true);
    // Enriched metadata
    assert.strictEqual(out.freshness, "fresh");
    assert.strictEqual(out.data_source, "remote_api");
    assert.strictEqual(out.token_source, "index");
  });

  it("handles empty results array", () => {
    const search = setup([], {});
    mockLark.run = () => ({
      ok: true,
      data: { results: [] },
    });

    const out = search.searchFeishu("nothing");
    assert.deepStrictEqual(out.results, []);
  });

  it("handles missing data.results gracefully", () => {
    const search = setup([], {});
    mockLark.run = () => ({
      ok: true,
      data: {},
    });

    const out = search.searchFeishu("x");
    assert.deepStrictEqual(out.results, []);
  });

  it("reports token_source as cloud_tokens when index unavailable", () => {
    const search = setup([], {}); // empty index pages
    mockCore.loadWikiTokensFromCloud = () => new Set(["tok_a"]);
    mockLark.run = () => ({
      ok: true,
      data: {
        results: [
          {
            title_highlighted: "Doc",
            summary_highlighted: "text",
            entity_type: "docx",
            result_meta: { token: "tok_a", url: "", owner_name: "", update_time_iso: "" },
          },
        ],
      },
    });

    const out = search.searchFeishu("Doc");
    assert.strictEqual(out.token_source, "cloud_tokens");
    assert.strictEqual(out.results.length, 1);
  });
});
