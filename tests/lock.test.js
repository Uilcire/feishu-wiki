/**
 * lock.test.js — tests for src/lib/lock.js
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const PROJ = path.resolve(__dirname, "..");
const LOCK_PATH = require.resolve(path.join(PROJ, "src/lib/lock.js"));
const CORE_PATH = require.resolve(path.join(PROJ, "src/lib/core.js"));
const LARK_PATH = require.resolve(path.join(PROJ, "src/lib/lark.js"));

// Track queue state for mock
let mockQueueContent = "";
let mockQueueEntries = [];
let syncCalled = false;
let larkRunCalls = [];

function setupMocks() {
  syncCalled = false;
  larkRunCalls = [];
  mockQueueEntries = [];

  const mockCore = {
    ensureCache: () => {},
    loadIndex: () => ({
      special_docs: {
        "队列": { obj_token: "tok_queue", node_token: "nt_queue", url: "" },
      },
      pages: {},
      root: { node_token: "nt_root" },
    }),
    saveIndex: () => {},
    sync: () => { syncCalled = true; },
  };

  const mockLark = {
    run: (args, opts) => {
      larkRunCalls.push({ args, opts });
      // Detect if this is a fetch (read queue)
      if (args.includes("+fetch")) {
        const lines = ["# 写入队列\n"];
        for (const [name, ts] of mockQueueEntries) {
          lines.push(`${name}|${ts}`);
        }
        return { ok: true, data: { markdown: lines.join("\n") } };
      }
      // Detect if this is an update (write queue)
      if (args.includes("+update")) {
        // Parse the markdown to extract entries
        const mdIdx = args.indexOf("--markdown");
        if (mdIdx >= 0) {
          const md = args[mdIdx + 1];
          mockQueueEntries = [];
          for (const line of md.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.includes("|") && !trimmed.startsWith("#")) {
              const parts = trimmed.split("|", 2);
              if (parts.length === 2) {
                mockQueueEntries.push([parts[0].trim(), parts[1].trim()]);
              }
            }
          }
        }
        return { ok: true };
      }
      return { ok: true };
    },
    isSuccess: (r) => Boolean(r) && (r.ok || r.code === 0),
    currentUser: () => ({ name: "TestUser", open_id: "ou_test" }),
    fetchDocMarkdown: () => {
      const lines = ["# 写入队列\n"];
      for (const [name, ts] of mockQueueEntries) {
        lines.push(`${name}|${ts}`);
      }
      return lines.join("\n");
    },
  };

  require.cache[CORE_PATH] = { id: CORE_PATH, filename: CORE_PATH, loaded: true, exports: mockCore };
  require.cache[LARK_PATH] = { id: LARK_PATH, filename: LARK_PATH, loaded: true, exports: mockLark };
  delete require.cache[LOCK_PATH];

  return require(LOCK_PATH);
}

function cleanup() {
  delete require.cache[LOCK_PATH];
  delete require.cache[CORE_PATH];
  delete require.cache[LARK_PATH];
}

// Suppress stderr output during tests
const origStderrWrite = process.stderr.write;

describe("lock", () => {
  afterEach(() => {
    cleanup();
    process.stderr.write = origStderrWrite;
  });

  it("isLocked returns false initially", () => {
    const lock = setupMocks();
    process.stderr.write = () => true;
    assert.strictEqual(lock.isLocked(), false);
  });

  it("isLocked returns true during withLock execution", () => {
    const lock = setupMocks();
    process.stderr.write = () => true;
    let wasLocked = false;
    lock.withLock(() => {
      wasLocked = lock.isLocked();
    });
    assert.strictEqual(wasLocked, true);
    assert.strictEqual(lock.isLocked(), false);
  });

  it("withLock runs the function and returns its value", () => {
    const lock = setupMocks();
    process.stderr.write = () => true;
    const result = lock.withLock(() => 42);
    assert.strictEqual(result, 42);
  });

  it("withLock releases lock even when fn throws", () => {
    const lock = setupMocks();
    process.stderr.write = () => true;
    assert.throws(() => {
      lock.withLock(() => { throw new Error("boom"); });
    }, { message: "boom" });
    assert.strictEqual(lock.isLocked(), false);
  });

  it("withLock calls sync after fn completes", () => {
    const lock = setupMocks();
    process.stderr.write = () => true;
    lock.withLock(() => {});
    assert.strictEqual(syncCalled, true);
  });

  it("withLock is re-entrant (nested withLock skips locking)", () => {
    const lock = setupMocks();
    process.stderr.write = () => true;
    let innerRan = false;
    lock.withLock(() => {
      lock.withLock(() => {
        innerRan = true;
      });
    });
    assert.strictEqual(innerRan, true);
  });

  it("withLock acquires lock (adds to queue) and releases (removes from queue)", () => {
    const lock = setupMocks();
    process.stderr.write = () => true;
    lock.withLock(() => {
      // During execution, user should be at queue head
      assert.ok(mockQueueEntries.some(([name]) => name === "TestUser"));
    });
    // After release, user should be removed
    assert.ok(!mockQueueEntries.some(([name]) => name === "TestUser"));
  });
});

// ---------------------------------------------------------------------------
// Test _cleanExpired behavior indirectly
// ---------------------------------------------------------------------------

describe("lock expiry handling", () => {
  afterEach(() => {
    cleanup();
    process.stderr.write = origStderrWrite;
  });

  it("expired entries are cleaned during acquire", () => {
    // Pre-populate queue with an expired entry
    const expiredTime = new Date(Date.now() - 400 * 1000).toISOString(); // 400s ago > 300s timeout
    mockQueueEntries = [["OldUser", expiredTime]];

    const lock = setupMocks();
    // Re-set the entries since setupMocks resets them
    mockQueueEntries = [["OldUser", expiredTime]];
    process.stderr.write = () => true;

    lock.withLock(() => {
      // OldUser should be cleaned, TestUser should be first
      const hasOld = mockQueueEntries.some(([n]) => n === "OldUser");
      assert.strictEqual(hasOld, false);
    });
  });
});
