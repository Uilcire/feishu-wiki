/**
 * commands.test.js — tests for lib/commands.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PROJ = path.resolve(__dirname, "..");
const COMMANDS_PATH = require.resolve(path.join(PROJ, "lib/commands.js"));
const CORE_PATH = require.resolve(path.join(PROJ, "lib/core.js"));
const SEARCH_PATH = require.resolve(path.join(PROJ, "lib/search.js"));
const LARK_PATH = require.resolve(path.join(PROJ, "lib/lark.js"));

let captured = { logs: [], errors: [], exitCode: null };
let origLog, origError, origExit, origStderrWrite;

function setupMocks(overrides = {}) {
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
// help
// ---------------------------------------------------------------------------

describe("help command", () => {
  afterEach(cleanup);

  it("shows help with no args", () => {
    const { main } = setupMocks();
    main([]);
    assert.ok(captured.logs.some((l) => l.includes("ai-wiki")));
  });

  it("shows help with 'help' arg", () => {
    const { main } = setupMocks();
    main(["help"]);
    assert.ok(captured.logs.some((l) => l.includes("ai-wiki")));
  });
});

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

describe("find command", () => {
  afterEach(cleanup);

  it("exits 1 with no query", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["find"]), /EXIT_1/);
    assert.ok(captured.errors.some((e) => e.includes("用法")));
  });

  it("outputs found page as JSON", () => {
    const { main } = setupMocks({
      core: { find: () => ({ title: "RAG", category: "主题" }) },
    });
    main(["find", "RAG"]);
    const output = captured.logs.join("\n");
    assert.ok(output.includes("RAG"));
  });

  it("exits 1 with error to stderr when page not found", () => {
    const { main } = setupMocks({ core: { find: () => null } });
    assert.throws(() => main(["find", "NonExistent"]), /EXIT_1/);
    assert.ok(captured.errors.some((e) => e.includes("未找到页面")));
    // Should NOT output "null" to stdout
    assert.ok(!captured.logs.some((l) => l === "null"));
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list command", () => {
  afterEach(cleanup);

  it("outputs page list as JSON", () => {
    const { main } = setupMocks({
      core: { listPages: () => [{ title: "A" }, { title: "B" }] },
    });
    main(["list"]);
    const output = captured.logs.join("\n");
    assert.ok(output.includes("A"));
    assert.ok(output.includes("B"));
  });

  it("passes category filter", () => {
    let receivedOpts;
    const { main } = setupMocks({
      core: {
        listPages: (opts) => { receivedOpts = opts; return []; },
      },
    });
    main(["list", "--category", "主题"]);
    assert.strictEqual(receivedOpts.category, "主题");
  });
});

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

describe("fetch command", () => {
  afterEach(cleanup);

  it("exits 1 with no query", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["fetch"]), /EXIT_1/);
  });

  it("exits 1 when page not found", () => {
    const { main } = setupMocks({ core: { fetch: () => { throw new Error("找不到页面: Missing"); } } });
    assert.throws(() => main(["fetch", "Missing"]), /EXIT_1/);
  });

  it("outputs content for found page", () => {
    const { main } = setupMocks({
      core: {
        fetch: () => "# Page Content",
      },
    });
    main(["fetch", "Page"]);
    assert.ok(captured.logs.some((l) => l.includes("Page Content")));
  });
});

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

describe("link command", () => {
  afterEach(cleanup);

  it("exits 1 with no query", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["link"]), /EXIT_1/);
  });

  it("outputs URL", () => {
    const { main } = setupMocks({
      core: { link: () => "https://lark.com/wiki/abc" },
    });
    main(["link", "Page"]);
    assert.ok(captured.logs.some((l) => l.includes("https://lark.com/wiki/abc")));
  });
});

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

describe("grep command", () => {
  afterEach(cleanup);

  it("exits 1 with no query", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["grep"]), /EXIT_1/);
  });

  it("outputs results as JSON", () => {
    const { main } = setupMocks({
      search: { grep: () => [{ title: "Page", matches: [{ line: 1, text: "hit" }] }] },
    });
    main(["grep", "pattern"]);
    assert.ok(captured.logs.join("").includes("Page"));
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe("search command", () => {
  afterEach(cleanup);

  it("exits 1 with no query", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["search"]), /EXIT_1/);
  });

  it("outputs results", () => {
    const { main } = setupMocks({
      search: { searchFeishu: () => [{ title: "Result" }] },
    });
    main(["search", "keyword"]);
    assert.ok(captured.logs.join("").includes("Result"));
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create command", () => {
  afterEach(cleanup);

  it("exits 1 without --category and --title", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["create"]), /EXIT_1/);
  });

  it("exits 1 without --title", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["create", "--category", "主题"]), /EXIT_1/);
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("update command", () => {
  afterEach(cleanup);

  it("exits 1 with no title", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["update"]), /EXIT_1/);
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("delete command", () => {
  afterEach(cleanup);

  it("exits 1 with no title", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["delete"]), /EXIT_1/);
  });
});

// ---------------------------------------------------------------------------
// status, sync, refresh, lint
// ---------------------------------------------------------------------------

describe("management commands", () => {
  afterEach(cleanup);

  it("status outputs JSON", () => {
    const { main } = setupMocks();
    main(["status"]);
    const output = captured.logs.join("\n");
    assert.ok(output.includes("ready"));
  });

  it("sync outputs JSON", () => {
    const { main } = setupMocks();
    main(["sync"]);
    assert.ok(captured.logs.join("").includes("uploaded"));
  });

  it("refresh outputs ok", () => {
    const { main } = setupMocks();
    main(["refresh"]);
    assert.ok(captured.logs.join("").includes("ok"));
  });

  it("lint outputs result", () => {
    const { main } = setupMocks();
    main(["lint"]);
    assert.ok(captured.logs.join("").includes("ok"));
  });
});

// ---------------------------------------------------------------------------
// user
// ---------------------------------------------------------------------------

describe("user command", () => {
  afterEach(cleanup);

  it("outputs current user", () => {
    const { main } = setupMocks();
    main(["user"]);
    assert.ok(captured.logs.join("").includes("TestUser"));
  });
});

// ---------------------------------------------------------------------------
// mode
// ---------------------------------------------------------------------------

describe("mode command", () => {
  afterEach(cleanup);

  it("shows current mode with no subcommand", () => {
    const { main } = setupMocks();
    main(["mode"]);
    assert.ok(captured.logs.some((l) => l.includes("模式")));
  });

  it("switches to write mode", () => {
    const { main } = setupMocks();
    const configPath = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".feishu-wiki-config.json"
    );
    const existed = fs.existsSync(configPath);
    let origContent;
    if (existed) origContent = fs.readFileSync(configPath, "utf-8");
    try {
      main(["mode", "write"]);
      assert.ok(captured.logs.some((l) => l.includes("贡献模式")));
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      assert.strictEqual(cfg.write_enabled, true);
    } finally {
      if (existed) fs.writeFileSync(configPath, origContent);
      else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    }
  });

  it("switches to read mode", () => {
    const { main } = setupMocks();
    const configPath = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".feishu-wiki-config.json"
    );
    const existed = fs.existsSync(configPath);
    let origContent;
    if (existed) origContent = fs.readFileSync(configPath, "utf-8");
    try {
      main(["mode", "read"]);
      assert.ok(captured.logs.some((l) => l.includes("学习模式")));
    } finally {
      if (existed) fs.writeFileSync(configPath, origContent);
      else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    }
  });

  it("exits 1 for invalid mode subcommand", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["mode", "banana"]), /EXIT_1/);
    assert.ok(captured.errors.some((e) => e.includes("未知模式")));
  });
});

// ---------------------------------------------------------------------------
// log-qa
// ---------------------------------------------------------------------------

describe("log-qa command", () => {
  afterEach(cleanup);

  it("exits 1 on invalid JSON input", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["log-qa", "--json", "not json"]), /EXIT_1/);
    assert.ok(captured.errors.some((e) => e.includes("无效的 JSON")));
  });
});

// ---------------------------------------------------------------------------
// unknown command
// ---------------------------------------------------------------------------

describe("unknown command", () => {
  afterEach(cleanup);

  it("exits 1 for unknown command", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["bogus"]), /EXIT_1/);
    assert.ok(captured.errors.some((e) => e.includes("未知命令")));
  });
});

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------

describe("feedback command", () => {
  afterEach(cleanup);

  it("exits 1 with no feedback text", () => {
    const { main } = setupMocks();
    assert.throws(() => main(["feedback"]), /EXIT_1/);
  });

  it("shows success message", () => {
    const { main } = setupMocks({ core: { feedback: () => ({ ok: true }) } });
    main(["feedback", "Great", "tool!"]);
    assert.ok(captured.logs.some((l) => l.includes("反馈已提交")));
  });
});
