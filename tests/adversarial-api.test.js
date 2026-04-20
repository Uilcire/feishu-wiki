/**
 * adversarial-api.test.js — 覆盖 moveDocToWiki 对真实 lark-cli 返回值的健壮性。
 *
 * 真实契约（lark-cli 1.0.11 schema 验证）：
 *   - 错误包：{ok:false, error:{type,message,hint}}（error 是对象不是字符串）
 *   - 成功包：{ok:true, data:{...}}，docs-to-wiki 可能返回 {task_id, applied:false}，
 *     此时不一定有 node_token / wiki_token（异步任务未完成）。
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJ = path.resolve(__dirname, "..");
const IMPORT_PATH = require.resolve(path.join(PROJ, "lib/import.js"));
const LARK_PATH = require.resolve(path.join(PROJ, "lib/lark.js"));

function cleanCache() {
  delete require.cache[IMPORT_PATH];
  delete require.cache[LARK_PATH];
}

describe("moveDocToWiki — lark-cli response contract", () => {
  afterEach(cleanCache);

  // 通过替换 child_process.execFileSync 模拟 lark-cli 输出
  function withStubbedCli(stdoutJson, fn) {
    const cp = require("child_process");
    const orig = cp.execFileSync;
    cp.execFileSync = () => JSON.stringify(stdoutJson);
    delete require.cache[LARK_PATH];
    try {
      const lark = require(LARK_PATH);
      return fn(lark);
    } finally {
      cp.execFileSync = orig;
      delete require.cache[LARK_PATH];
    }
  }

  it("extracts error.message when lark-cli returns {error:{message}}", () => {
    withStubbedCli(
      { ok: false, error: { type: "permission_denied", message: "你没有该文档的权限" } },
      (lark) => {
        const r = lark.moveDocToWiki("docx", "tok", "parent", "sp");
        assert.strictEqual(r.ok, false);
        assert.strictEqual(typeof r.error, "string");
        assert.ok(r.error.includes("你没有该文档的权限"), `got: ${r.error}`);
      }
    );
  });

  it("falls back to r.msg when error is absent", () => {
    withStubbedCli(
      { ok: false, code: 99991668, msg: "rate limited" },
      (lark) => {
        const r = lark.moveDocToWiki("docx", "tok", "parent", "sp");
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, "rate limited");
      }
    );
  });

  it("returns pending:true when API returns task_id without node/wiki_token", () => {
    // 关键不回归测试：绝不能标记成功
    withStubbedCli(
      { ok: true, data: { task_id: "task_abc123", applied: false } },
      (lark) => {
        const r = lark.moveDocToWiki("docx", "tok", "parent", "sp");
        assert.strictEqual(r.ok, false, "异步任务不能被视为成功");
        assert.strictEqual(r.pending, true);
        assert.strictEqual(r.task_id, "task_abc123");
      }
    );
  });

  it("accepts wiki_token as node_token fallback (sync success)", () => {
    withStubbedCli(
      { ok: true, data: { wiki_token: "wkn_xyz", applied: true } },
      (lark) => {
        const r = lark.moveDocToWiki("docx", "tok", "parent", "sp");
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.node_token, "wkn_xyz");
      }
    );
  });

  it("accepts data.node.node_token path", () => {
    withStubbedCli(
      { ok: true, data: { node: { node_token: "nt_ok" } } },
      (lark) => {
        const r = lark.moveDocToWiki("docx", "tok", "parent", "sp");
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.node_token, "nt_ok");
      }
    );
  });
});

describe("applyImport — does not falsely mark pending tasks as imported", () => {
  afterEach(cleanCache);

  it("pending task_id result leaves imported_at null so re-run retries", () => {
    // 直接用 deps 注入 mock lark，模拟异步任务返回
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adv-"));
    const candPath = path.join(tmp, "c.json");
    fs.writeFileSync(
      candPath,
      JSON.stringify([
        {
          token: "t1", title: "A", obj_type: "docx", parent_path: "", url: "",
          relevant: true, reason: "", approved: true,
          imported_at: null, new_wiki_url: null, error: null,
        },
      ])
    );

    delete require.cache[IMPORT_PATH];
    const imp = require(IMPORT_PATH);
    const mockLark = {
      moveDocToWiki: () => ({
        ok: false,
        pending: true,
        task_id: "task_xyz",
        error: "docs-to-wiki 返回异步任务（task_id=task_xyz），尚未完成",
      }),
    };
    const summary = imp.applyImport(
      { candidatesPath: candPath, destinationNodeToken: "dest", spaceId: "sp" },
      { lark: mockLark }
    );
    assert.strictEqual(summary.succeeded, 0);
    assert.strictEqual(summary.failed, 1);
    const saved = JSON.parse(fs.readFileSync(candPath, "utf-8"));
    assert.strictEqual(saved[0].imported_at, null, "imported_at 不能被设置 —— 否则无法重试");
    assert.strictEqual(saved[0].new_wiki_url, null);
    assert.strictEqual(saved[0].pending_task_id, "task_xyz");
    assert.ok(saved[0].error.includes("task_xyz"));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("error-as-object (raw {type,message,hint}) stringifies via message", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adv-"));
    const candPath = path.join(tmp, "c.json");
    fs.writeFileSync(
      candPath,
      JSON.stringify([
        {
          token: "t1", title: "A", obj_type: "docx", parent_path: "", url: "",
          relevant: true, reason: "", approved: true,
          imported_at: null, new_wiki_url: null, error: null,
        },
      ])
    );

    delete require.cache[IMPORT_PATH];
    const imp = require(IMPORT_PATH);
    // 模拟 moveDocToWiki 未做转换时会透传 object
    const mockLark = {
      moveDocToWiki: () => ({
        ok: false,
        error: { type: "permission_denied", message: "权限不足", hint: "x" },
      }),
    };
    const summary = imp.applyImport(
      { candidatesPath: candPath, destinationNodeToken: "dest", spaceId: "sp" },
      { lark: mockLark }
    );
    assert.strictEqual(summary.failed, 1);
    const saved = JSON.parse(fs.readFileSync(candPath, "utf-8"));
    assert.strictEqual(typeof saved[0].error, "string");
    assert.strictEqual(saved[0].error, "权限不足");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("scanDriveFolder — drive.files.list schema check", () => {
  it("verifies code matches real lark-cli schema field names", () => {
    // Schema (lark-cli schema drive.files.list) 确认：
    //   response: {files: [{token, type, name, url, parent_token, ...}], has_more, next_page_token}
    // 代码假设与 schema 一致 —— 只断言实现读的是正确字段名。
    const larkSrc = fs.readFileSync(path.join(PROJ, "lib/lark.js"), "utf-8");
    assert.ok(larkSrc.includes("data.files"), "必须读 data.files");
    assert.ok(larkSrc.includes("has_more"), "必须读 has_more");
    assert.ok(larkSrc.includes("next_page_token"), "必须读 next_page_token");
  });
});
