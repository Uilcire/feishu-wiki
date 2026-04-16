/**
 * cmd-search-perf.test.js — tests for performance optimizations in commands.js and search.js
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const PROJ = path.resolve(__dirname, "..");
const COMMANDS_PATH = require.resolve(path.join(PROJ, "lib/commands.js"));
const CORE_PATH = require.resolve(path.join(PROJ, "lib/core.js"));
const SEARCH_PATH = require.resolve(path.join(PROJ, "lib/search.js"));
const LARK_PATH = require.resolve(path.join(PROJ, "lib/lark.js"));

let captured = { logs: [], errors: [], exitCode: null };
let origLog, origError, origExit, origStderrWrite;

function setupCommandMocks(overrides = {}) {
  captured = { logs: [], errors: [], exitCode: null };
  origLog = console.log;
  origError = console.error;
  origExit = process.exit;
  origStderrWrite = process.stderr.write;

  console.log = (...args) => captured.logs.push(args.join(" "));
  console.error = (...args) => captured.errors.push(args.join(" "));
  process.exit = (code) => { captured.exitCode = code; throw new Error(`EXIT_${code}`); };
  process.stderr.write = () => true;

  const mockCore = {
    find: () => null,
    listPages: () => [],
    fetch: () => "",
    link: () => "",
    create: () => ({ ok: true }),
    update: () => {},
    del: () => {},
    status: () => ({ cache: "ready", pages: 5 }),
    sync: () => ({ uploaded: 0 }),
    refresh: () => {},
    lint: () => ({ ok: true, issues: [], stats: {} }),
    feedback: () => ({ ok: true }),
    logQa: () => ({ ok: true }),
    ...overrides.core,
  };

  const mockSearch = {
    grep: () => [],
    searchFeishu: () => [],
    ...overrides.search,
  };

  const mockLark = {
    currentUser: () => ({ name: "TestUser", open_id: "ou_test" }),
    ...overrides.lark,
  };

  require.cache[CORE_PATH] = { id: CORE_PATH, filename: CORE_PATH, loaded: true, exports: mockCore };
  require.cache[SEARCH_PATH] = { id: SEARCH_PATH, filename: SEARCH_PATH, loaded: true, exports: mockSearch };
  require.cache[LARK_PATH] = { id: LARK_PATH, filename: LARK_PATH, loaded: true, exports: mockLark };
  delete require.cache[COMMANDS_PATH];

  return require(COMMANDS_PATH);
}

function cleanup() {
  console.log = origLog;
  console.error = origError;
  process.exit = origExit;
  process.stderr.write = origStderrWrite;
  delete require.cache[COMMANDS_PATH];
  delete require.cache[CORE_PATH];
  delete require.cache[SEARCH_PATH];
  delete require.cache[LARK_PATH];
}

// ---------------------------------------------------------------------------
// fetch command: no double lookup (find should NOT be called)
// ---------------------------------------------------------------------------

describe("fetch command — no double lookup", () => {
  afterEach(cleanup);

  it("calls fetch directly without calling find", () => {
    let fetchCount = 0;
    let findCount = 0;
    const { main } = setupCommandMocks({
      core: {
        fetch: (query) => { fetchCount++; return `# Content for ${query}`; },
        find: () => { findCount++; return { title: "Page", node_token: "tok" }; },
      },
    });

    main(["fetch", "SomePage"]);

    assert.strictEqual(fetchCount, 1, "fetch should be called exactly once");
    assert.strictEqual(findCount, 0, "find should NOT be called — fetch handles lookup internally");
    assert.ok(captured.logs.some((l) => l.includes("Content for SomePage")));
  });

  it("passes --fresh flag through to fetch", () => {
    let receivedOpts;
    const { main } = setupCommandMocks({
      core: {
        fetch: (_q, opts) => { receivedOpts = opts; return "content"; },
      },
    });

    main(["fetch", "Page", "--fresh"]);

    assert.strictEqual(receivedOpts.fresh, true, "--fresh flag should be passed to core.fetch");
  });
});

// ---------------------------------------------------------------------------
// fetch command: error handling (try/catch with exit 1)
// ---------------------------------------------------------------------------

describe("fetch command — error handling", () => {
  afterEach(cleanup);

  it("exits with code 1 when fetch throws", () => {
    const { main } = setupCommandMocks({
      core: {
        fetch: () => { throw new Error("找不到页面: Missing"); },
      },
    });

    assert.throws(() => main(["fetch", "Missing"]), /EXIT_1/);
    assert.strictEqual(captured.exitCode, 1);
  });

  it("writes error message to stderr when fetch throws", () => {
    const { main } = setupCommandMocks({
      core: {
        fetch: () => { throw new Error("找不到页面: NoSuch"); },
      },
    });

    assert.throws(() => main(["fetch", "NoSuch"]), /EXIT_1/);
    assert.ok(
      captured.errors.some((e) => e.includes("找不到页面: NoSuch")),
      "stderr should contain the error message from the thrown error"
    );
  });

  it("does not output anything to stdout on error", () => {
    const { main } = setupCommandMocks({
      core: {
        fetch: () => { throw new Error("boom"); },
      },
    });

    assert.throws(() => main(["fetch", "X"]), /EXIT_1/);
    assert.strictEqual(captured.logs.length, 0, "nothing should be logged to stdout on error");
  });
});

// ---------------------------------------------------------------------------
// search.js: wiki token caching (_wikiTokensCache)
// ---------------------------------------------------------------------------

describe("searchFeishu — wiki token caching", () => {
  afterEach(() => {
    delete require.cache[SEARCH_PATH];
    delete require.cache[CORE_PATH];
    delete require.cache[LARK_PATH];
  });

  it("calls loadIndex only once across multiple searchFeishu calls", () => {
    let loadIndexCount = 0;

    const mockCore = {
      ensureCache: () => {},
      listPages: () => [],
      docCachePath: (t) => `/tmp/${t}.md`,
      loadIndex: () => {
        loadIndexCount++;
        return {
          pages: {
            "RAG": { obj_token: "tok_rag" },
            "Agent": { obj_token: "tok_agent" },
          },
        };
      },
      loadWikiTokensFromCloud: () => null,
    };

    const mockLark = {
      run: () => ({
        ok: true,
        data: {
          results: [
            {
              title_highlighted: "RAG",
              summary_highlighted: "about RAG",
              entity_type: "docx",
              result_meta: {
                token: "tok_rag",
                url: "https://lark.com/doc/1",
                owner_name: "Alice",
                update_time_iso: "2026-04-01T00:00:00Z",
              },
            },
          ],
        },
      }),
      isSuccess: (r) => Boolean(r) && (r.ok || r.code === 0),
    };

    // Inject mocks and load fresh search module
    delete require.cache[SEARCH_PATH];
    require.cache[CORE_PATH] = { id: CORE_PATH, filename: CORE_PATH, loaded: true, exports: mockCore };
    require.cache[LARK_PATH] = { id: LARK_PATH, filename: LARK_PATH, loaded: true, exports: mockLark };
    const search = require(SEARCH_PATH);

    // First call — should invoke loadIndex
    const r1 = search.searchFeishu("RAG");
    assert.strictEqual(r1.length, 1);
    assert.strictEqual(loadIndexCount, 1, "loadIndex should be called on first searchFeishu");

    // Second call — should use cached tokens, NOT call loadIndex again
    const r2 = search.searchFeishu("RAG");
    assert.strictEqual(r2.length, 1);
    assert.strictEqual(loadIndexCount, 1, "loadIndex should NOT be called again — tokens are cached");
  });

  it("caches cloud tokens when index is empty", () => {
    let loadIndexCount = 0;
    let cloudTokenCount = 0;

    const mockCore = {
      ensureCache: () => {},
      listPages: () => [],
      docCachePath: (t) => `/tmp/${t}.md`,
      loadIndex: () => {
        loadIndexCount++;
        return { pages: {} }; // empty index
      },
      loadWikiTokensFromCloud: () => {
        cloudTokenCount++;
        return new Set(["tok_cloud"]);
      },
    };

    const mockLark = {
      run: () => ({
        ok: true,
        data: {
          results: [
            {
              title_highlighted: "Doc",
              summary_highlighted: "summary",
              entity_type: "docx",
              result_meta: {
                token: "tok_cloud",
                url: "",
                owner_name: "",
                update_time_iso: "",
              },
            },
          ],
        },
      }),
      isSuccess: (r) => Boolean(r) && (r.ok || r.code === 0),
    };

    delete require.cache[SEARCH_PATH];
    require.cache[CORE_PATH] = { id: CORE_PATH, filename: CORE_PATH, loaded: true, exports: mockCore };
    require.cache[LARK_PATH] = { id: LARK_PATH, filename: LARK_PATH, loaded: true, exports: mockLark };
    const search = require(SEARCH_PATH);

    search.searchFeishu("test");
    search.searchFeishu("test");

    assert.strictEqual(loadIndexCount, 1, "loadIndex called once");
    assert.strictEqual(cloudTokenCount, 1, "loadWikiTokensFromCloud called once");
  });
});
