/**
 * adversarial-import.test.js — 攻击性测试：批量导入功能的输入滥用与状态破坏
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-import-"));
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
    id: LARK_PATH, filename: LARK_PATH, loaded: true, exports: mockLark || {},
  };
  delete require.cache[IMPORT_PATH];
  return require(IMPORT_PATH);
}

// ---------------------------------------------------------------------------
// mergeCandidates: duplicate token handling
// ---------------------------------------------------------------------------

describe("adversarial: mergeCandidates duplicates", () => {
  afterEach(cleanup);

  it("does NOT produce duplicate merged entries when scanned has dup tokens", () => {
    setup();
    const imp = loadImport();
    const scanned = [
      { token: "t1", title: "first", obj_type: "docx", parent_path: "A", url: "" },
      { token: "t1", title: "second", obj_type: "docx", parent_path: "B", url: "" },
    ];
    const merged = imp.mergeCandidates([], scanned);
    // One token, one entry.
    assert.strictEqual(merged.length, 1, "duplicate scanned tokens must be collapsed");
    assert.strictEqual(merged[0].token, "t1");
  });

  it("does NOT duplicate existing entries that share a token (dedupes by token)", () => {
    setup();
    const imp = loadImport();
    const existing = [
      { token: "t1", title: "v1", approved: true, relevant: true, reason: "", imported_at: null,
        new_wiki_url: null, error: null, obj_type: "docx", parent_path: "", url: "" },
      { token: "t1", title: "v2", approved: false, relevant: false, reason: "", imported_at: null,
        new_wiki_url: null, error: null, obj_type: "docx", parent_path: "", url: "" },
    ];
    const merged = imp.mergeCandidates(existing, []);
    assert.strictEqual(merged.length, 1, "duplicate existing tokens must be collapsed");
  });
});

// ---------------------------------------------------------------------------
// Scan cycle safety
// ---------------------------------------------------------------------------

describe("adversarial: scanDriveFolder cycle", () => {
  afterEach(cleanup);

  it("survives folder cycle without infinite loop", () => {
    setup();
    const tree = {
      root: [{ token: "sub", type: "folder", name: "sub", url: "" }],
      sub: [
        { token: "root", type: "folder", name: "back", url: "" },
        { token: "d1", type: "docx", name: "D1", url: "" },
      ],
    };
    const imp = loadImport({ listDriveChildren: (t) => tree[t] || [] });
    const out = imp.scanDriveFolder("root");
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].title, "D1");
  });
});

// ---------------------------------------------------------------------------
// Apply: dry-run in read mode (should be allowed)
// ---------------------------------------------------------------------------

describe("adversarial: apply --dry-run in read mode", () => {
  afterEach(cleanup);

  it("allows dry-run even when write mode is off (no mutation)", () => {
    setup();
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const cfgPath = path.join(home, ".feishu-wiki-config.json");
    const existed = fs.existsSync(cfgPath);
    const orig = existed ? fs.readFileSync(cfgPath, "utf-8") : null;

    const captured = { logs: [], errors: [], exitCode: null };
    const origLog = console.log;
    const origError = console.error;
    const origExit = process.exit;
    console.log = (...args) => captured.logs.push(args.join(" "));
    console.error = (...args) => captured.errors.push(args.join(" "));
    process.exit = (code) => { captured.exitCode = code; throw new Error(`EXIT_${code}`); };

    try {
      // Put write mode OFF
      fs.writeFileSync(cfgPath, JSON.stringify({ write_enabled: false }));

      let applyCalled = false;
      require.cache[IMPORT_PATH] = {
        id: IMPORT_PATH, filename: IMPORT_PATH, loaded: true,
        exports: {
          loadCandidates: () => [],
          saveCandidates: () => {},
          mergeCandidates: (a, b) => b,
          scanDriveFolder: () => [],
          applyImport: (opts) => {
            applyCalled = true;
            assert.strictEqual(opts.dryRun, true);
            return { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
          },
          expandHome: (p) => p,
        },
      };
      delete require.cache[COMMANDS_PATH];
      const { main } = require(COMMANDS_PATH);
      // Should NOT throw EXIT_1 — dry-run is safe in read mode.
      main(["import", "apply", "--dry-run"]);
      assert.ok(applyCalled, "applyImport must be called even in read mode for dry-run");
    } finally {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
      if (existed) fs.writeFileSync(cfgPath, orig);
      else if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
    }
  });
});

// ---------------------------------------------------------------------------
// saveCandidates: do not clobber an existing file with empty array
// on corrupt-read → no data loss
// ---------------------------------------------------------------------------

describe("adversarial: apply never overwrites corrupt file with []", () => {
  afterEach(cleanup);

  it("refuses to proceed if candidates file exists but is unreadable/corrupt", () => {
    setup();
    const imp = loadImport({
      moveDocToWiki: () => { throw new Error("should not be called"); },
    });
    const candPath = path.join(tmpDir, "c.json");
    // Simulate corruption: not valid JSON.
    fs.writeFileSync(candPath, "{not valid json at all");
    const before = fs.readFileSync(candPath, "utf-8");

    assert.throws(
      () => imp.applyImport({
        candidatesPath: candPath,
        destinationNodeToken: "dest",
        spaceId: "sp",
      }),
      /corrupt|invalid|parse/i,
      "applyImport should error out rather than silently overwriting a corrupt file"
    );
    // File must be untouched.
    const after = fs.readFileSync(candPath, "utf-8");
    assert.strictEqual(before, after, "corrupt file must not be silently overwritten");
  });
});

// ---------------------------------------------------------------------------
// saveCandidates is atomic (tmp + rename)
// ---------------------------------------------------------------------------

describe("adversarial: saveCandidates atomicity", () => {
  afterEach(cleanup);

  it("writes atomically so an interrupted write never leaves a truncated file", () => {
    setup();
    const imp = loadImport();
    const candPath = path.join(tmpDir, "c.json");

    // Pre-populate a valid file.
    fs.writeFileSync(candPath, JSON.stringify([{ token: "pre", title: "pre" }]));

    // Monkey-patch writeFileSync to assert the write target is a temp file
    // (atomic write: write tmp, then rename).
    const origWrite = fs.writeFileSync;
    let sawTmp = false;
    fs.writeFileSync = (p, ...rest) => {
      if (typeof p === "string" && p !== candPath && p.startsWith(candPath)) {
        sawTmp = true;
      }
      return origWrite(p, ...rest);
    };
    try {
      imp.saveCandidates(candPath, [{ token: "new", title: "new" }]);
    } finally {
      fs.writeFileSync = origWrite;
    }
    assert.ok(sawTmp, "saveCandidates should write to a tmp path then rename");
    const saved = JSON.parse(fs.readFileSync(candPath, "utf-8"));
    assert.strictEqual(saved[0].token, "new");
  });
});
