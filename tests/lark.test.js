/**
 * lark.test.js — tests for src/lib/lark.js
 */

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");

let execMock;

function setupMock(fn) {
  execMock = mock.method(childProcess, "execFileSync", fn);
}

function loadLark() {
  const modPath = require.resolve("../src/lib/lark.js");
  delete require.cache[modPath];
  return require(modPath);
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

describe("run", () => {
  afterEach(() => execMock?.mock.restore());

  it("returns parsed JSON on success", () => {
    setupMock(() => JSON.stringify({ ok: true, data: "hello" }));
    const lark = loadLark();
    const result = lark.run(["docs", "get"]);
    assert.deepStrictEqual(result, { ok: true, data: "hello" });
    const call = execMock.mock.calls[0];
    assert.strictEqual(call.arguments[0], "lark-cli");
    assert.deepStrictEqual(call.arguments[1], ["docs", "get"]);
  });

  it("returns null when command fails and check=false (default)", () => {
    setupMock(() => { throw new Error("command not found"); });
    const lark = loadLark();
    assert.strictEqual(lark.run(["bad", "cmd"]), null);
  });

  it("throws when command fails and check=true", () => {
    const err = new Error("boom");
    err.stderr = Buffer.from("stderr details");
    setupMock(() => { throw err; });
    const lark = loadLark();
    assert.throws(
      () => lark.run(["bad"], { check: true }),
      (e) => e.message.includes("lark-cli 失败") && e.message.includes("stderr details")
    );
  });

  it("throws with err.message when stderr is absent and check=true", () => {
    setupMock(() => { throw new Error("some error msg"); });
    const lark = loadLark();
    assert.throws(
      () => lark.run(["x"], { check: true }),
      (e) => e.message.includes("some error msg")
    );
  });

  it("passes timeout option to execFileSync", () => {
    setupMock(() => JSON.stringify({ ok: true }));
    const lark = loadLark();
    lark.run(["x"], { timeout: 5000 });
    assert.strictEqual(execMock.mock.calls[0].arguments[2].timeout, 5000);
  });

  it("uses default timeout of 30000", () => {
    setupMock(() => JSON.stringify({ ok: true }));
    const lark = loadLark();
    lark.run(["x"]);
    assert.strictEqual(execMock.mock.calls[0].arguments[2].timeout, 30000);
  });

  it("returns null when stdout is not valid JSON and check=false", () => {
    setupMock(() => "not json");
    const lark = loadLark();
    assert.strictEqual(lark.run(["x"]), null);
  });
});

// ---------------------------------------------------------------------------
// isSuccess()
// ---------------------------------------------------------------------------

describe("isSuccess", () => {
  let lark;
  beforeEach(() => {
    setupMock(() => "{}");
    lark = loadLark();
  });
  afterEach(() => execMock?.mock.restore());

  it("returns true for {ok: true}", () => {
    assert.strictEqual(lark.isSuccess({ ok: true }), true);
  });

  it("returns true for {code: 0}", () => {
    assert.strictEqual(lark.isSuccess({ code: 0 }), true);
  });

  it("returns false for null", () => {
    assert.strictEqual(lark.isSuccess(null), false);
  });

  it("returns false for undefined", () => {
    assert.strictEqual(lark.isSuccess(undefined), false);
  });

  it("returns false for {ok: false}", () => {
    assert.strictEqual(lark.isSuccess({ ok: false }), false);
  });

  it("returns false for empty object", () => {
    assert.strictEqual(lark.isSuccess({}), false);
  });

  it("returns false for {code: 1}", () => {
    assert.strictEqual(lark.isSuccess({ code: 1 }), false);
  });
});

// ---------------------------------------------------------------------------
// currentUser()
// ---------------------------------------------------------------------------

describe("currentUser", () => {
  afterEach(() => execMock?.mock.restore());

  it("parses userName and userOpenId from auth status", () => {
    setupMock(() => JSON.stringify({ userName: "Alice", userOpenId: "ou_abc" }));
    const lark = loadLark();
    assert.deepStrictEqual(lark.currentUser(), { name: "Alice", open_id: "ou_abc" });
  });

  it("returns unknown/empty when auth fails", () => {
    setupMock(() => { throw new Error("fail"); });
    const lark = loadLark();
    assert.deepStrictEqual(lark.currentUser(), { name: "unknown", open_id: "" });
  });

  it("caches result across multiple calls", () => {
    let callCount = 0;
    setupMock(() => { callCount++; return JSON.stringify({ userName: "Bob", userOpenId: "ou_bob" }); });
    const lark = loadLark();
    const u1 = lark.currentUser();
    const u2 = lark.currentUser();
    assert.strictEqual(u1, u2); // same ref
    assert.strictEqual(callCount, 1);
  });

  it("defaults name to unknown when userName missing", () => {
    setupMock(() => JSON.stringify({ userOpenId: "ou_x" }));
    const lark = loadLark();
    assert.strictEqual(lark.currentUser().name, "unknown");
    assert.strictEqual(lark.currentUser().open_id, "ou_x");
  });

  it("defaults open_id to empty when userOpenId missing", () => {
    setupMock(() => JSON.stringify({ userName: "Charlie" }));
    const lark = loadLark();
    assert.strictEqual(lark.currentUser().open_id, "");
  });
});

// ---------------------------------------------------------------------------
// fetchDocMarkdown()
// ---------------------------------------------------------------------------

describe("fetchDocMarkdown", () => {
  afterEach(() => execMock?.mock.restore());

  it("returns markdown on success", () => {
    setupMock(() => JSON.stringify({ ok: true, data: { markdown: "# Hello" } }));
    const lark = loadLark();
    assert.strictEqual(lark.fetchDocMarkdown("tok_abc"), "# Hello");
  });

  it("returns empty string when data.markdown is missing", () => {
    setupMock(() => JSON.stringify({ ok: true, data: {} }));
    const lark = loadLark();
    assert.strictEqual(lark.fetchDocMarkdown("tok"), "");
  });

  it("returns empty string when result is not ok", () => {
    setupMock(() => JSON.stringify({ ok: false }));
    const lark = loadLark();
    assert.strictEqual(lark.fetchDocMarkdown("tok"), "");
  });

  it("retries on rate limit error then succeeds", () => {
    let attempt = 0;
    setupMock(() => {
      attempt++;
      if (attempt === 1) throw new Error("lark-cli 失败: frequency limit exceeded");
      return JSON.stringify({ ok: true, data: { markdown: "retried" } });
    });
    const lark = loadLark();
    assert.strictEqual(lark.fetchDocMarkdown("tok", 3), "retried");
    assert.strictEqual(attempt, 2);
  });

  it("throws immediately on non-rate-limit error", () => {
    setupMock(() => { throw new Error("lark-cli 失败: permission denied"); });
    const lark = loadLark();
    assert.throws(
      () => lark.fetchDocMarkdown("tok", 3),
      (e) => e.message.includes("permission denied")
    );
  });

  it("exhausts retries on persistent rate limit", () => {
    let callCount = 0;
    setupMock(() => { callCount++; throw new Error("lark-cli 失败: rate limited"); });
    const lark = loadLark();
    assert.throws(() => lark.fetchDocMarkdown("tok", 2));
    assert.strictEqual(callCount, 2);
  });
});

// ---------------------------------------------------------------------------
// uploadPage()
// ---------------------------------------------------------------------------

describe("uploadPage", () => {
  afterEach(() => execMock?.mock.restore());

  it("succeeds when result is ok", () => {
    setupMock(() => JSON.stringify({ ok: true }));
    const lark = loadLark();
    lark.uploadPage("My Page", "tok_123", "# Content");
    const args = execMock.mock.calls[0].arguments[1];
    assert.ok(args.includes("--doc"));
    assert.ok(args.includes("tok_123"));
    assert.ok(args.includes("--markdown"));
  });

  it("throws when result is not success", () => {
    setupMock(() => JSON.stringify({ ok: false }));
    const lark = loadLark();
    assert.throws(
      () => lark.uploadPage("Title", "tok", "body"),
      (e) => e.message.includes("上传失败 Title")
    );
  });

  it("throws when lark-cli command itself fails", () => {
    setupMock(() => { throw new Error("timeout"); });
    const lark = loadLark();
    assert.throws(
      () => lark.uploadPage("T", "tok", "c"),
      (e) => e.message.includes("lark-cli 失败")
    );
  });
});

// ---------------------------------------------------------------------------
// listChildren()
// ---------------------------------------------------------------------------

describe("listChildren", () => {
  afterEach(() => execMock?.mock.restore());

  it("returns items from a single page", () => {
    setupMock(() => JSON.stringify({
      ok: true,
      data: { items: [{ title: "A" }, { title: "B" }], has_more: false },
    }));
    const lark = loadLark();
    assert.deepStrictEqual(lark.listChildren("n1", "s1"), [{ title: "A" }, { title: "B" }]);
  });

  it("paginates through multiple pages", () => {
    let page = 0;
    setupMock(() => {
      page++;
      if (page === 1) return JSON.stringify({ ok: true, data: { items: [{ title: "A" }], has_more: true, page_token: "pt2" } });
      if (page === 2) return JSON.stringify({ ok: true, data: { items: [{ title: "B" }], has_more: true, page_token: "pt3" } });
      return JSON.stringify({ ok: true, data: { items: [{ title: "C" }], has_more: false } });
    });
    const lark = loadLark();
    assert.deepStrictEqual(lark.listChildren("n1", "s1"), [{ title: "A" }, { title: "B" }, { title: "C" }]);
    assert.strictEqual(page, 3);
  });

  it("returns empty array when first call fails", () => {
    setupMock(() => { throw new Error("network"); });
    const lark = loadLark();
    assert.deepStrictEqual(lark.listChildren("n1", "s1"), []);
  });

  it("returns partial results when pagination fails mid-way", () => {
    let page = 0;
    setupMock(() => {
      page++;
      if (page === 1) return JSON.stringify({ ok: true, data: { items: [{ title: "A" }], has_more: true, page_token: "pt2" } });
      throw new Error("fail");
    });
    const lark = loadLark();
    assert.deepStrictEqual(lark.listChildren("n1", "s1"), [{ title: "A" }]);
  });

  it("stops when has_more but page_token is empty", () => {
    setupMock(() => JSON.stringify({
      ok: true,
      data: { items: [{ title: "A" }], has_more: true, page_token: "" },
    }));
    const lark = loadLark();
    assert.deepStrictEqual(lark.listChildren("n1", "s1"), [{ title: "A" }]);
  });
});
