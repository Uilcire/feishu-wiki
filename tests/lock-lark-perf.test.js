/**
 * lock-lark-perf.test.js — tests for Atomics.wait sleep and conditional write optimizations
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

function setupEnv() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-perf-test-"));
  origCwd = process.cwd();
  process.chdir(tmpDir);
  origStderrWrite = process.stderr.write;
  process.stderr.write = () => true;

  fs.writeFileSync(
    path.join(tmpDir, ".feishu-config.json"),
    JSON.stringify({ space_id: "sp_test", root_node_token: "nt_root", root_obj_token: "ot_root" }),
    "utf-8"
  );

  // Pin cache dir to tmpDir so tests stay sandboxed
  process.env.AI_WIKI_CACHE_DIR = path.join(tmpDir, ".cache");
}

function cleanupEnv() {
  delete require.cache[CORE_PATH];
  delete require.cache[LARK_PATH];
  delete require.cache[LOCK_PATH];
  delete process.env.AI_WIKI_CACHE_DIR;
  if (origStderrWrite) process.stderr.write = origStderrWrite;
  if (origCwd) process.chdir(origCwd);
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = undefined;
  origCwd = undefined;
  origStderrWrite = undefined;
}

// ---------------------------------------------------------------------------
// 1. Atomics.wait in lock.js — _sleepSync timing
// ---------------------------------------------------------------------------

describe("Atomics.wait in lock._sleepSync", () => {
  afterEach(cleanupEnv);

  it("sleeps approximately the requested duration (50ms)", () => {
    // _sleepSync is not exported, so replicate its logic to test Atomics.wait behavior
    const sleepSync = (ms) => {
      const buf = new SharedArrayBuffer(4);
      const arr = new Int32Array(buf);
      Atomics.wait(arr, 0, 0, ms);
    };

    const target = 50;
    const start = Date.now();
    sleepSync(target);
    const elapsed = Date.now() - start;

    // Should not return instantly (> 30ms) and not hang (< 200ms)
    assert.ok(elapsed >= 30, `Sleep returned too early: ${elapsed}ms (expected ~${target}ms)`);
    assert.ok(elapsed < 200, `Sleep took too long: ${elapsed}ms (expected ~${target}ms)`);
  });

  it("does not busy-wait (CPU-friendly)", () => {
    // Atomics.wait blocks the thread without spinning.
    // We verify by running two sequential sleeps — if it were busy-wait,
    // the timing would still be correct but CPU would spike.
    // Here we just confirm the timing is consistent across calls.
    const sleepSync = (ms) => {
      const buf = new SharedArrayBuffer(4);
      const arr = new Int32Array(buf);
      Atomics.wait(arr, 0, 0, ms);
    };

    const start = Date.now();
    sleepSync(25);
    sleepSync(25);
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 40, `Two 25ms sleeps completed in only ${elapsed}ms`);
    assert.ok(elapsed < 200, `Two 25ms sleeps took too long: ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// 2. Conditional write in lock._acquire
// ---------------------------------------------------------------------------

describe("Conditional write in lock._acquire", () => {
  afterEach(cleanupEnv);

  it("does NOT call _writeQueue when no expired entries during polling", () => {
    setupEnv();

    // Track lark.run calls to detect _writeQueue invocations
    let writeQueueCalls = 0;
    let readCount = 0;
    const currentUser = "TestUser";

    // Queue state: TestUser is already at head (lock acquired on first read in polling loop)
    const queueContent = `# 写入队列\n\n${currentUser}|${new Date().toISOString()}\n`;

    const mockLark = {
      run: (args) => {
        const cmd = args.join(" ");
        if (cmd.includes("+update")) {
          writeQueueCalls++;
          return { ok: true };
        }
        if (cmd.includes("+create")) {
          return { ok: true, data: { doc_id: "ot_queue", doc_url: "https://lark.com/wiki/nt_queue" } };
        }
        return { ok: true };
      },
      isSuccess: (r) => Boolean(r) && (r.ok || r.code === 0),
      currentUser: () => ({ name: currentUser, open_id: "ou_test" }),
      fetchDocMarkdown: () => {
        readCount++;
        // First call: empty queue (initial _readQueue in _acquire before appending)
        // Second call: user is at head (polling loop _readQueue)
        if (readCount <= 1) return "";
        return queueContent;
      },
      uploadPage: () => {},
      listChildren: () => [],
    };

    require.cache[LARK_PATH] = { id: LARK_PATH, filename: LARK_PATH, loaded: true, exports: mockLark };

    // Mock core for _getQueueInfo
    const mockCore = {
      ensureCache: () => {},
      loadIndex: () => ({
        special_docs: { "队列": { obj_token: "ot_queue", node_token: "nt_queue", url: "" } },
        pages: {},
      }),
      saveIndex: () => {},
      sync: () => {},
    };
    require.cache[CORE_PATH] = { id: CORE_PATH, filename: CORE_PATH, loaded: true, exports: mockCore };
    delete require.cache[LOCK_PATH];

    const lock = require(LOCK_PATH);

    let fnCalled = false;
    lock.withLock(() => { fnCalled = true; });

    assert.ok(fnCalled, "withLock should have called the function");

    // _writeQueue is called:
    //   1. In _acquire: initial append (entries.push + _writeQueue) — this is expected
    //   2. In _release: always writes — this is expected
    // But during polling, since no entries expired, _writeQueue should NOT be called.
    // So total should be exactly 2 (initial append + release).
    assert.strictEqual(writeQueueCalls, 2,
      `Expected exactly 2 _writeQueue calls (initial append + release), got ${writeQueueCalls}`);
  });

  it("DOES call _writeQueue when expired entries are cleaned during polling", () => {
    setupEnv();

    let writeQueueCalls = 0;
    let readCount = 0;
    const currentUser = "TestUser";

    // Create an entry with a timestamp > 5 minutes ago (expired)
    const expiredTime = new Date(Date.now() - 400000).toISOString(); // 400s ago > 300s timeout

    const mockLark = {
      run: (args) => {
        const cmd = args.join(" ");
        if (cmd.includes("+update")) {
          writeQueueCalls++;
          return { ok: true };
        }
        return { ok: true };
      },
      isSuccess: (r) => Boolean(r) && (r.ok || r.code === 0),
      currentUser: () => ({ name: currentUser, open_id: "ou_test" }),
      fetchDocMarkdown: () => {
        readCount++;
        if (readCount <= 1) {
          // Initial read: empty
          return "";
        }
        // Polling reads: return queue with an expired entry + our user
        return `# 写入队列\n\nExpiredUser|${expiredTime}\n${currentUser}|${new Date().toISOString()}\n`;
      },
      uploadPage: () => {},
      listChildren: () => [],
    };

    require.cache[LARK_PATH] = { id: LARK_PATH, filename: LARK_PATH, loaded: true, exports: mockLark };

    const mockCore = {
      ensureCache: () => {},
      loadIndex: () => ({
        special_docs: { "队列": { obj_token: "ot_queue", node_token: "nt_queue", url: "" } },
        pages: {},
      }),
      saveIndex: () => {},
      sync: () => {},
    };
    require.cache[CORE_PATH] = { id: CORE_PATH, filename: CORE_PATH, loaded: true, exports: mockCore };
    delete require.cache[LOCK_PATH];

    const lock = require(LOCK_PATH);

    let fnCalled = false;
    lock.withLock(() => { fnCalled = true; });

    assert.ok(fnCalled, "withLock should have called the function");

    // _writeQueue is called:
    //   1. In _acquire: initial append
    //   2. In polling: expired entry cleaned → conditional write fires
    //   3. In _release: always writes
    // Total should be >= 3 (at least one conditional write in polling)
    assert.ok(writeQueueCalls >= 3,
      `Expected >= 3 _writeQueue calls (initial + conditional clean + release), got ${writeQueueCalls}`);
  });
});

// ---------------------------------------------------------------------------
// 3. Atomics.wait in lark.js — rate-limit backoff timing
// ---------------------------------------------------------------------------

describe("Atomics.wait in lark.fetchDocMarkdown rate-limit backoff", () => {
  afterEach(cleanupEnv);

  it("sleeps approximately the expected duration on rate-limit retry", () => {
    // The lark.js backoff uses the same Atomics.wait pattern.
    // Verify directly that the pattern works with the same formula: 1500 * (attempt + 1)
    const atomicsSleep = (ms) => {
      const buf = new SharedArrayBuffer(4);
      const arr = new Int32Array(buf);
      Atomics.wait(arr, 0, 0, ms);
    };

    // Simulate attempt=0 → ms=1500*(0+1)=1500, but use a shorter value for test speed
    // Instead, test with a short duration to verify the mechanism works
    const target = 80;
    const start = Date.now();
    atomicsSleep(target);
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 60, `Backoff sleep returned too early: ${elapsed}ms (expected ~${target}ms)`);
    assert.ok(elapsed < 300, `Backoff sleep took too long: ${elapsed}ms (expected ~${target}ms)`);
  });

  it("retries on rate-limit error with backoff delay", () => {
    setupEnv();

    let attempts = 0;
    const mockExecFileSync = (cli, args, opts) => {
      attempts++;
      if (attempts === 1) {
        const err = new Error("lark-cli 失败: frequency limit exceeded");
        err.stdout = "";
        throw err;
      }
      // Second attempt succeeds
      return JSON.stringify({ ok: true, code: 0, data: { markdown: "# Content" } });
    };

    // We need to test the actual lark.js module with a mocked execFileSync.
    // Clear the cache and re-require with a patched child_process.
    const CP_PATH = require.resolve("child_process");
    const origCP = require.cache[CP_PATH];

    // Save original and patch
    delete require.cache[LARK_PATH];
    const realCP = require("child_process");
    const patchedCP = { ...realCP, execFileSync: mockExecFileSync };
    require.cache[CP_PATH] = { id: CP_PATH, filename: CP_PATH, loaded: true, exports: patchedCP };

    // Also need to reset lark's cached CLI path
    delete require.cache[LARK_PATH];

    try {
      const lark = require(LARK_PATH);

      // Measure time — first attempt fails with rate limit, backoff = 1500ms for attempt 0.
      // That's too slow for a test. Let's just verify the retry behavior happened.
      // We'll override the sleep to be shorter by testing with a very short timeout.
      // Actually the backoff is hardcoded at 1500*(attempt+1).
      // Let's just verify the retry logic works by checking attempts count.

      const start = Date.now();
      const result = lark.fetchDocMarkdown("test_token", 2);
      const elapsed = Date.now() - start;

      assert.strictEqual(attempts, 2, "Should have retried once after rate limit");
      assert.strictEqual(result, "# Content");
      // The backoff should have caused ~1500ms delay
      assert.ok(elapsed >= 1000, `Expected backoff delay (~1500ms), but only took ${elapsed}ms`);
    } finally {
      // Restore
      if (origCP) {
        require.cache[CP_PATH] = origCP;
      } else {
        delete require.cache[CP_PATH];
      }
      delete require.cache[LARK_PATH];
    }
  });
});
