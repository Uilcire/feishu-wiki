/**
 * import.test.js — tests for lib/import.js
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJ = path.resolve(__dirname, "..");
const IMPORT_PATH = require.resolve(path.join(PROJ, "lib/import.js"));
const LARK_PATH = require.resolve(path.join(PROJ, "lib/lark.js"));
const COMMANDS_PATH = require.resolve(path.join(PROJ, "lib/commands.js"));

let tmpDir;
let origStderrWrite;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-test-"));
  origStderrWrite = process.stderr.write;
  process.stderr.write = () => true;
}

function cleanup() {
  process.stderr.write = origStderrWrite;
  delete require.cache[IMPORT_PATH];
  delete require.cache[LARK_PATH];
  delete require.cache[COMMANDS_PATH];
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function loadImport(mockLark) {
  require.cache[LARK_PATH] = {
    id: LARK_PATH,
    filename: LARK_PATH,
    loaded: true,
    exports: mockLark,
  };
  delete require.cache[IMPORT_PATH];
  return require(IMPORT_PATH);
}

// ---------------------------------------------------------------------------
// mergeCandidates
// ---------------------------------------------------------------------------

describe("mergeCandidates", () => {
  afterEach(cleanup);

  it("preserves user decisions when re-scanning", () => {
    setup();
    const imp = loadImport({});
    const existing = [
      {
        token: "t1", title: "旧标题", obj_type: "docx", parent_path: "A",
        url: "u1", relevant: true, reason: "核心资料", approved: true,
        imported_at: null, new_wiki_url: null, error: null,
      },
    ];
    const scanned = [
      { token: "t1", title: "新标题", obj_type: "docx", parent_path: "A/新", url: "u1" },
    ];
    const merged = imp.mergeCandidates(existing, scanned);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].relevant, true);
    assert.strictEqual(merged[0].reason, "核心资料");
    assert.strictEqual(merged[0].approved, true);
    // 元数据以最新扫描为准
    assert.strictEqual(merged[0].title, "新标题");
    assert.strictEqual(merged[0].parent_path, "A/新");
  });

  it("adds new entries with defaults", () => {
    setup();
    const imp = loadImport({});
    const scanned = [
      { token: "new1", title: "全新", obj_type: "docx", parent_path: "B", url: "u" },
    ];
    const merged = imp.mergeCandidates([], scanned);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].relevant, null);
    assert.strictEqual(merged[0].reason, "");
    assert.strictEqual(merged[0].approved, false);
    assert.strictEqual(merged[0].imported_at, null);
    assert.strictEqual(merged[0].new_wiki_url, null);
    assert.strictEqual(merged[0].error, null);
  });

  it("keeps existing entries not present in latest scan", () => {
    setup();
    const imp = loadImport({});
    const existing = [
      { token: "t1", title: "A", imported_at: "2025-01-01", approved: true, relevant: true, reason: "", error: null, new_wiki_url: "u", obj_type: "docx", parent_path: "", url: "" },
    ];
    const merged = imp.mergeCandidates(existing, []);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].token, "t1");
  });
});

// ---------------------------------------------------------------------------
// scanDriveFolder
// ---------------------------------------------------------------------------

describe("scanDriveFolder", () => {
  afterEach(cleanup);

  it("recurses into subfolders and flattens results", () => {
    setup();
    const tree = {
      root: [
        { token: "sub1", type: "folder", name: "子目录", url: "", parent_token: "root" },
        { token: "docA", type: "docx", name: "A", url: "urlA", parent_token: "root" },
      ],
      sub1: [
        { token: "docB", type: "docx", name: "B", url: "urlB", parent_token: "sub1" },
      ],
    };
    const mockLark = {
      listDriveChildren: (token) => tree[token] || [],
    };
    const imp = loadImport(mockLark);
    const out = imp.scanDriveFolder("root");
    assert.strictEqual(out.length, 2);
    const titles = out.map((x) => x.title).sort();
    assert.deepStrictEqual(titles, ["A", "B"]);
    const b = out.find((x) => x.title === "B");
    assert.strictEqual(b.parent_path, "子目录");
  });

  it("skips non-docx types (sheet, bitable, file)", () => {
    setup();
    const mockLark = {
      listDriveChildren: () => [
        { token: "d1", type: "docx", name: "Doc", url: "", parent_token: "root" },
        { token: "s1", type: "sheet", name: "表格", url: "", parent_token: "root" },
        { token: "b1", type: "bitable", name: "多维", url: "", parent_token: "root" },
        { token: "f1", type: "file", name: "文件", url: "", parent_token: "root" },
      ],
    };
    const imp = loadImport(mockLark);
    const out = imp.scanDriveFolder("root");
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].obj_type, "docx");
  });
});

// ---------------------------------------------------------------------------
// applyImport
// ---------------------------------------------------------------------------

describe("applyImport", () => {
  afterEach(cleanup);

  it("skips entries already imported", () => {
    setup();
    const calls = [];
    const mockLark = {
      moveDocToWiki: (...args) => {
        calls.push(args);
        return { ok: true, node_token: "new_nt" };
      },
    };
    const imp = loadImport(mockLark);
    const candPath = path.join(tmpDir, "c.json");
    fs.writeFileSync(candPath, JSON.stringify([
      {
        token: "t1", title: "A", obj_type: "docx", parent_path: "", url: "",
        relevant: true, reason: "", approved: true,
        imported_at: "2025-01-01T00:00:00Z", new_wiki_url: "u", error: null,
      },
    ]));
    const summary = imp.applyImport({
      candidatesPath: candPath,
      destinationNodeToken: "dest",
      spaceId: "sp",
    });
    assert.strictEqual(summary.attempted, 0);
    assert.strictEqual(summary.skipped, 1);
    assert.strictEqual(calls.length, 0);
  });

  it("updates entry with new_wiki_url on success", () => {
    setup();
    const mockLark = {
      moveDocToWiki: () => ({ ok: true, node_token: "nt_new" }),
    };
    const imp = loadImport(mockLark);
    const candPath = path.join(tmpDir, "c.json");
    fs.writeFileSync(candPath, JSON.stringify([
      {
        token: "t1", title: "A", obj_type: "docx", parent_path: "", url: "",
        relevant: true, reason: "", approved: true,
        imported_at: null, new_wiki_url: null, error: null,
      },
    ]));
    const summary = imp.applyImport({
      candidatesPath: candPath,
      destinationNodeToken: "dest",
      spaceId: "sp",
    });
    assert.strictEqual(summary.succeeded, 1);
    const saved = JSON.parse(fs.readFileSync(candPath, "utf-8"));
    assert.ok(saved[0].imported_at);
    assert.ok(saved[0].new_wiki_url.includes("nt_new"));
    assert.strictEqual(saved[0].error, null);
  });

  it("records error on failure and keeps going", () => {
    setup();
    let n = 0;
    const mockLark = {
      moveDocToWiki: () => {
        n++;
        if (n === 1) return { ok: false, error: "权限不足" };
        return { ok: true, node_token: "nt2" };
      },
    };
    const imp = loadImport(mockLark);
    const candPath = path.join(tmpDir, "c.json");
    fs.writeFileSync(candPath, JSON.stringify([
      { token: "t1", title: "A", obj_type: "docx", parent_path: "", url: "",
        relevant: true, reason: "", approved: true,
        imported_at: null, new_wiki_url: null, error: null },
      { token: "t2", title: "B", obj_type: "docx", parent_path: "", url: "",
        relevant: true, reason: "", approved: true,
        imported_at: null, new_wiki_url: null, error: null },
    ]));
    const summary = imp.applyImport({
      candidatesPath: candPath,
      destinationNodeToken: "dest",
      spaceId: "sp",
    });
    assert.strictEqual(summary.attempted, 2);
    assert.strictEqual(summary.succeeded, 1);
    assert.strictEqual(summary.failed, 1);
    const saved = JSON.parse(fs.readFileSync(candPath, "utf-8"));
    assert.strictEqual(saved[0].error, "权限不足");
    assert.strictEqual(saved[0].imported_at, null);
    assert.ok(saved[1].imported_at);
  });

  it("dry-run makes no lark calls", () => {
    setup();
    let invoked = 0;
    const mockLark = {
      moveDocToWiki: () => { invoked++; return { ok: true, node_token: "x" }; },
    };
    const imp = loadImport(mockLark);
    const candPath = path.join(tmpDir, "c.json");
    fs.writeFileSync(candPath, JSON.stringify([
      { token: "t1", title: "A", obj_type: "docx", parent_path: "", url: "",
        relevant: true, reason: "", approved: true,
        imported_at: null, new_wiki_url: null, error: null },
    ]));
    const summary = imp.applyImport({
      candidatesPath: candPath,
      destinationNodeToken: "dest",
      spaceId: "sp",
      dryRun: true,
    });
    assert.strictEqual(summary.attempted, 1);
    assert.strictEqual(summary.succeeded, 0);
    assert.strictEqual(invoked, 0);
    const saved = JSON.parse(fs.readFileSync(candPath, "utf-8"));
    assert.strictEqual(saved[0].imported_at, null);
  });

  it("skips entries not approved", () => {
    setup();
    let invoked = 0;
    const mockLark = {
      moveDocToWiki: () => { invoked++; return { ok: true, node_token: "x" }; },
    };
    const imp = loadImport(mockLark);
    const candPath = path.join(tmpDir, "c.json");
    fs.writeFileSync(candPath, JSON.stringify([
      { token: "t1", title: "A", obj_type: "docx", parent_path: "", url: "",
        relevant: null, reason: "", approved: false,
        imported_at: null, new_wiki_url: null, error: null },
    ]));
    const summary = imp.applyImport({
      candidatesPath: candPath,
      destinationNodeToken: "dest",
      spaceId: "sp",
    });
    assert.strictEqual(summary.skipped, 1);
    assert.strictEqual(invoked, 0);
  });
});

// ---------------------------------------------------------------------------
// CLI smoke tests
// ---------------------------------------------------------------------------

function setupCmdMocks(importMock) {
  const captured = { logs: [], errors: [], exitCode: null };
  const origLog = console.log;
  const origError = console.error;
  const origExit = process.exit;
  console.log = (...args) => captured.logs.push(args.join(" "));
  console.error = (...args) => captured.errors.push(args.join(" "));
  process.exit = (code) => { captured.exitCode = code; throw new Error(`EXIT_${code}`); };

  require.cache[require.resolve(path.join(PROJ, "lib/import.js"))] = {
    id: IMPORT_PATH, filename: IMPORT_PATH, loaded: true, exports: importMock,
  };
  delete require.cache[COMMANDS_PATH];
  const { main } = require(COMMANDS_PATH);
  return {
    main,
    captured,
    restore: () => {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
    },
  };
}

describe("import CLI smoke", () => {
  afterEach(cleanup);

  it("`import` with no subcommand shows usage and exits 1", () => {
    setup();
    const { main, captured, restore } = setupCmdMocks({});
    try {
      assert.throws(() => main(["import"]), /EXIT_1/);
      assert.ok(captured.errors.some((e) => e.includes("scan")));
    } finally {
      restore();
    }
  });

  it("`import scan` without folder_token exits 1", () => {
    setup();
    const { main, captured, restore } = setupCmdMocks({
      loadCandidates: () => [],
      saveCandidates: () => {},
      mergeCandidates: (a, b) => b,
      scanDriveFolder: () => [],
    });
    try {
      assert.throws(() => main(["import", "scan"]), /EXIT_1/);
      assert.ok(captured.errors.some((e) => e.includes("用法")));
    } finally {
      restore();
    }
  });

  it("`import list` prints candidates JSON", () => {
    setup();
    const { main, captured, restore } = setupCmdMocks({
      loadCandidates: () => [
        { token: "t1", title: "A", relevant: null, approved: false, imported_at: null },
      ],
    });
    try {
      main(["import", "list", "--all"]);
      const out = captured.logs.join("\n");
      assert.ok(out.includes("t1"));
      assert.ok(out.includes("entries"));
    } finally {
      restore();
    }
  });

  it("`import apply` syncs index + root page after non-dry-run success", () => {
    setup();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const cfgPath = path.join(home, ".feishu-wiki-config.json");
    const existed = fs.existsSync(cfgPath);
    let orig;
    if (existed) orig = fs.readFileSync(cfgPath, "utf-8");
    try {
      fs.writeFileSync(cfgPath, JSON.stringify({ write_enabled: true }));
      // Stub core.js so we can observe refresh + syncRootPage calls without
      // touching the real Feishu API or local cache.
      const CORE_PATH = require.resolve(path.join(PROJ, "lib/core.js"));
      const coreCalls = { refresh: 0, syncRootPage: 0 };
      require.cache[CORE_PATH] = {
        id: CORE_PATH, filename: CORE_PATH, loaded: true,
        exports: {
          refresh: () => { coreCalls.refresh++; },
          syncRootPage: () => { coreCalls.syncRootPage++; },
        },
      };
      const { main, restore } = setupCmdMocks({
        applyImport: () => ({ attempted: 1, succeeded: 1, failed: 0, skipped: 0 }),
      });
      try {
        main(["import", "apply"]);
        assert.strictEqual(coreCalls.refresh, 1);
        assert.strictEqual(coreCalls.syncRootPage, 1);
      } finally {
        restore();
        delete require.cache[CORE_PATH];
      }
    } finally {
      if (existed) fs.writeFileSync(cfgPath, orig);
      else if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
    }
  });

  it("`import apply --dry-run` does NOT sync", () => {
    setup();
    const CORE_PATH = require.resolve(path.join(PROJ, "lib/core.js"));
    const coreCalls = { refresh: 0, syncRootPage: 0 };
    require.cache[CORE_PATH] = {
      id: CORE_PATH, filename: CORE_PATH, loaded: true,
      exports: {
        refresh: () => { coreCalls.refresh++; },
        syncRootPage: () => { coreCalls.syncRootPage++; },
      },
    };
    const { main, restore } = setupCmdMocks({
      applyImport: () => ({ attempted: 1, succeeded: 0, failed: 0, skipped: 0 }),
    });
    try {
      main(["import", "apply", "--dry-run"]);
      assert.strictEqual(coreCalls.refresh, 0);
      assert.strictEqual(coreCalls.syncRootPage, 0);
    } finally {
      restore();
      delete require.cache[CORE_PATH];
    }
  });

  it("`import apply` with zero successes does NOT sync", () => {
    setup();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const cfgPath = path.join(home, ".feishu-wiki-config.json");
    const existed = fs.existsSync(cfgPath);
    let orig;
    if (existed) orig = fs.readFileSync(cfgPath, "utf-8");
    try {
      fs.writeFileSync(cfgPath, JSON.stringify({ write_enabled: true }));
      const CORE_PATH = require.resolve(path.join(PROJ, "lib/core.js"));
      const coreCalls = { refresh: 0, syncRootPage: 0 };
      require.cache[CORE_PATH] = {
        id: CORE_PATH, filename: CORE_PATH, loaded: true,
        exports: {
          refresh: () => { coreCalls.refresh++; },
          syncRootPage: () => { coreCalls.syncRootPage++; },
        },
      };
      const { main, restore } = setupCmdMocks({
        applyImport: () => ({ attempted: 0, succeeded: 0, failed: 0, skipped: 3 }),
      });
      try {
        main(["import", "apply"]);
        assert.strictEqual(coreCalls.refresh, 0);
        assert.strictEqual(coreCalls.syncRootPage, 0);
      } finally {
        restore();
        delete require.cache[CORE_PATH];
      }
    } finally {
      if (existed) fs.writeFileSync(cfgPath, orig);
      else if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
    }
  });

  it("`import apply` tolerates sync failure without aborting", () => {
    setup();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const cfgPath = path.join(home, ".feishu-wiki-config.json");
    const existed = fs.existsSync(cfgPath);
    let orig;
    if (existed) orig = fs.readFileSync(cfgPath, "utf-8");
    try {
      fs.writeFileSync(cfgPath, JSON.stringify({ write_enabled: true }));
      const CORE_PATH = require.resolve(path.join(PROJ, "lib/core.js"));
      require.cache[CORE_PATH] = {
        id: CORE_PATH, filename: CORE_PATH, loaded: true,
        exports: {
          refresh: () => { throw new Error("boom"); },
          syncRootPage: () => {},
        },
      };
      const { main, captured, restore } = setupCmdMocks({
        applyImport: () => ({ attempted: 1, succeeded: 1, failed: 0, skipped: 0 }),
      });
      try {
        main(["import", "apply"]);
        const out = captured.logs.join("\n");
        // 应该仍然打印了成功的 summary，并带上 sync_error
        assert.ok(out.includes("\"succeeded\": 1"));
        assert.ok(out.includes("sync_error"));
        assert.ok(out.includes("boom"));
      } finally {
        restore();
        delete require.cache[CORE_PATH];
      }
    } finally {
      if (existed) fs.writeFileSync(cfgPath, orig);
      else if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
    }
  });

  it("`import apply` blocked in read mode", () => {
    setup();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const cfgPath = path.join(home, ".feishu-wiki-config.json");
    const existed = fs.existsSync(cfgPath);
    let orig;
    if (existed) orig = fs.readFileSync(cfgPath, "utf-8");
    try {
      fs.writeFileSync(cfgPath, JSON.stringify({ write_enabled: false }));
      const { main, captured, restore } = setupCmdMocks({
        applyImport: () => ({ attempted: 0, succeeded: 0, failed: 0, skipped: 0 }),
      });
      try {
        assert.throws(() => main(["import", "apply"]), /EXIT_1/);
        assert.ok(captured.errors.some((e) => e.includes("学习模式")));
      } finally {
        restore();
      }
    } finally {
      if (existed) fs.writeFileSync(cfgPath, orig);
      else if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
    }
  });
});
