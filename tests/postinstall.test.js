/**
 * postinstall.test.js — tests for src/scripts/postinstall.js
 *
 * Since postinstall.js runs main() at import time and modifies real directories,
 * we test it by running it as a subprocess with a mocked HOME.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const POSTINSTALL = path.resolve(__dirname, "..", "src", "scripts", "postinstall.js");
const SKILLS_SRC = path.resolve(__dirname, "..", "src", "skills");

function runPostinstall(env = {}) {
  try {
    const stdout = execFileSync("node", [POSTINSTALL], {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
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

describe("postinstall script", () => {
  let tmpHome;

  afterEach(() => {
    if (tmpHome && fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("creates skill files in ~/.agents/skills/ai-wiki/", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "postinstall-test-"));
    const r = runPostinstall({ HOME: tmpHome });

    const skillDir = path.join(tmpHome, ".agents", "skills", "ai-wiki");
    assert.ok(fs.existsSync(skillDir), "skill directory should be created");
    assert.ok(
      fs.existsSync(path.join(skillDir, "SKILL.md")),
      "SKILL.md should be copied"
    );
  });

  it("SKILL.md has correct frontmatter name", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "postinstall-test-"));
    runPostinstall({ HOME: tmpHome });

    const skillMd = fs.readFileSync(
      path.join(tmpHome, ".agents", "skills", "ai-wiki", "SKILL.md"),
      "utf-8"
    );
    assert.ok(skillMd.includes("name: ai-wiki"));
  });

  it("copies templates directory", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "postinstall-test-"));
    runPostinstall({ HOME: tmpHome });

    const tplDir = path.join(tmpHome, ".agents", "skills", "ai-wiki", "templates");
    assert.ok(fs.existsSync(tplDir), "templates directory should be copied");
  });

  it("copies references directory", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "postinstall-test-"));
    runPostinstall({ HOME: tmpHome });

    const refDir = path.join(tmpHome, ".agents", "skills", "ai-wiki", "references");
    assert.ok(fs.existsSync(refDir), "references directory should be copied");
  });

  it("copies agents directory", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "postinstall-test-"));
    runPostinstall({ HOME: tmpHome });

    const agentsDir = path.join(tmpHome, ".agents", "skills", "ai-wiki", "agents");
    assert.ok(fs.existsSync(agentsDir), "agents directory should be copied");
  });

  it("creates Claude symlink when .claude dir exists", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "postinstall-test-"));
    fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
    runPostinstall({ HOME: tmpHome });

    const link = path.join(tmpHome, ".claude", "skills", "ai-wiki");
    assert.ok(fs.existsSync(link), "symlink should be created");
    // Verify it's a symlink
    const stat = fs.lstatSync(link);
    assert.ok(stat.isSymbolicLink(), "should be a symlink");
  });

  it("cleans up old feishu-wiki skill directory", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "postinstall-test-"));
    const oldDir = path.join(tmpHome, ".agents", "skills", "feishu-wiki");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "SKILL.md"), "old content");

    runPostinstall({ HOME: tmpHome });

    assert.ok(!fs.existsSync(oldDir), "old feishu-wiki dir should be removed");
    assert.ok(
      fs.existsSync(path.join(tmpHome, ".agents", "skills", "ai-wiki")),
      "new ai-wiki dir should exist"
    );
  });

  it("outputs success message", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "postinstall-test-"));
    const r = runPostinstall({ HOME: tmpHome });
    assert.ok(
      r.stdout.includes("AI Wiki") || r.stdout.includes("ai-wiki"),
      "should show success message"
    );
  });
});
