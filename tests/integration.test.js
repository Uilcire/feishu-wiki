/**
 * integration.test.js — CLI end-to-end tests
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const CLI = path.resolve(__dirname, "..", "src", "bin", "cli.js");

function run(args, opts = {}) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: err.status || 1,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI basic invocations
// ---------------------------------------------------------------------------

describe("CLI help", () => {
  it("ai-wiki help exits 0 and shows usage", () => {
    const r = run(["help"]);
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.stdout.includes("ai-wiki"));
    assert.ok(r.stdout.includes("find"));
    assert.ok(r.stdout.includes("list"));
  });

  it("ai-wiki (no args) shows help", () => {
    const r = run([]);
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.stdout.includes("ai-wiki"));
  });
});

describe("CLI error handling", () => {
  it("unknown command exits non-zero", () => {
    const r = run(["totally-unknown-cmd"]);
    assert.notStrictEqual(r.exitCode, 0);
  });

  it("find without query exits 1", () => {
    const r = run(["find"]);
    assert.strictEqual(r.exitCode, 1);
  });

  it("fetch without query exits 1", () => {
    const r = run(["fetch"]);
    assert.strictEqual(r.exitCode, 1);
  });

  it("link without query exits 1", () => {
    const r = run(["link"]);
    assert.strictEqual(r.exitCode, 1);
  });

  it("grep without query exits 1", () => {
    const r = run(["grep"]);
    assert.strictEqual(r.exitCode, 1);
  });

  it("search without query exits 1", () => {
    const r = run(["search"]);
    assert.strictEqual(r.exitCode, 1);
  });

  it("create without args exits 1", () => {
    const r = run(["create"]);
    assert.strictEqual(r.exitCode, 1);
  });

  it("update without title exits 1", () => {
    const r = run(["update"]);
    assert.strictEqual(r.exitCode, 1);
  });

  it("delete without title exits 1", () => {
    const r = run(["delete"]);
    assert.strictEqual(r.exitCode, 1);
  });

  it("feedback without text exits 1", () => {
    const r = run(["feedback"]);
    assert.strictEqual(r.exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

describe("CLI mode", () => {
  const configPath = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".feishu-wiki-config.json"
  );
  let origContent;
  let existed;

  afterEach(() => {
    if (existed) fs.writeFileSync(configPath, origContent);
    else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  });

  it("mode shows current mode", () => {
    existed = fs.existsSync(configPath);
    if (existed) origContent = fs.readFileSync(configPath, "utf-8");

    const r = run(["mode"]);
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.stdout.includes("模式"));
  });

  it("mode read switches to read mode", () => {
    existed = fs.existsSync(configPath);
    if (existed) origContent = fs.readFileSync(configPath, "utf-8");

    const r = run(["mode", "read"]);
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.stdout.includes("学习模式"));
  });

  it("mode write switches to write mode", () => {
    existed = fs.existsSync(configPath);
    if (existed) origContent = fs.readFileSync(configPath, "utf-8");

    const r = run(["mode", "write"]);
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.stdout.includes("贡献模式"));
  });
});

// ---------------------------------------------------------------------------
// Package.json validation
// ---------------------------------------------------------------------------

describe("package.json integrity", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "src", "package.json"), "utf-8")
  );

  it("has correct name", () => {
    assert.strictEqual(pkg.name, "ai-wiki");
  });

  it("has semver version", () => {
    assert.ok(/^\d+\.\d+\.\d+/.test(pkg.version));
  });

  it("bin points to existing cli.js", () => {
    const binPath = path.resolve(__dirname, "..", "src", pkg.bin["ai-wiki"]);
    assert.ok(fs.existsSync(binPath));
  });

  it("requires node >= 16", () => {
    assert.ok(pkg.engines.node.includes("16"));
  });
});
