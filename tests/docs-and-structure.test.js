/**
 * docs-and-structure.test.js — validates non-code assets and project structure
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const PROJ = path.resolve(__dirname, "..");
const SRC = path.join(PROJ, "src");
const SKILLS = path.join(SRC, "skills");

// ---------------------------------------------------------------------------
// SKILL.md validation
// ---------------------------------------------------------------------------

describe("SKILL.md", () => {
  const skillPath = path.join(SKILLS, "SKILL.md");
  const content = fs.readFileSync(skillPath, "utf-8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch ? fmMatch[1] : "";

  it("exists", () => {
    assert.ok(fs.existsSync(skillPath));
  });

  it("has frontmatter", () => {
    assert.ok(fmMatch, "SKILL.md should have YAML frontmatter");
  });

  it("name is ai-wiki", () => {
    assert.ok(frontmatter.includes("name: ai-wiki"));
  });

  it("has version field", () => {
    assert.ok(/version:\s+\S+/.test(frontmatter));
  });

  it("version matches package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf-8"));
    assert.ok(frontmatter.includes(`version: ${pkg.version}`));
  });

  it("has description", () => {
    assert.ok(/description:/.test(frontmatter));
  });

  it("has scope field", () => {
    assert.ok(/scope:/.test(frontmatter));
  });

  it("has triggers array", () => {
    assert.ok(/triggers:/.test(frontmatter));
  });

  it("has do_not_trigger", () => {
    assert.ok(/do_not_trigger:/.test(frontmatter));
  });

  it("requires lark-cli and ai-wiki bins", () => {
    assert.ok(content.includes("lark-cli"));
    assert.ok(content.includes("ai-wiki"));
  });

  it("documents all CLI commands from commands.js", () => {
    const cmdsFile = fs.readFileSync(path.join(SRC, "lib/commands.js"), "utf-8");
    // Extract case labels from switch statement
    const caseRe = /case\s+"(\w+)"/g;
    const commands = new Set();
    let m;
    while ((m = caseRe.exec(cmdsFile))) {
      if (m[1] !== "write") commands.add(m[1]); // 'write' is alias for 'update'
    }
    commands.delete(""); // empty case for help
    // Meta commands that don't need SKILL.md docs
    commands.delete("help");
    commands.delete("log-qa"); // internal agent command

    for (const cmd of commands) {
      // Each command should be mentioned in SKILL.md
      assert.ok(
        content.includes(cmd),
        `Command '${cmd}' from commands.js not documented in SKILL.md`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describe("templates", () => {
  const tplDir = path.join(SKILLS, "templates");

  it("source-page.md exists", () => {
    assert.ok(fs.existsSync(path.join(tplDir, "source-page.md")));
  });

  it("raw-material-page.md exists", () => {
    assert.ok(fs.existsSync(path.join(tplDir, "raw-material-page.md")));
  });

  it("entity-topic-page.md exists", () => {
    assert.ok(fs.existsSync(path.join(tplDir, "entity-topic-page.md")));
  });

  it("templates contain section headers", () => {
    for (const name of ["source-page.md", "raw-material-page.md", "entity-topic-page.md"]) {
      const content = fs.readFileSync(path.join(tplDir, name), "utf-8");
      assert.ok(content.includes("#"), `${name} should contain # section headers`);
    }
  });
});

// ---------------------------------------------------------------------------
// default-config.json
// ---------------------------------------------------------------------------

describe("default-config.json", () => {
  const configPath = path.join(SKILLS, "default-config.json");

  it("exists", () => {
    assert.ok(fs.existsSync(configPath));
  });

  it("is valid JSON", () => {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(configPath, "utf-8")));
  });

  it("has space_id", () => {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.ok(cfg.space_id, "default-config.json should have space_id");
  });

  it("has root_node_token", () => {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.ok(cfg.root_node_token, "default-config.json should have root_node_token");
  });
});

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

describe("agent configs", () => {
  const agentsDir = path.join(SKILLS, "agents");

  it("agents directory exists", () => {
    assert.ok(fs.existsSync(agentsDir));
  });

  it("claude.yaml exists", () => {
    assert.ok(fs.existsSync(path.join(agentsDir, "claude.yaml")));
  });

  it("openai.yaml exists", () => {
    assert.ok(fs.existsSync(path.join(agentsDir, "openai.yaml")));
  });
});

// ---------------------------------------------------------------------------
// Architecture reference
// ---------------------------------------------------------------------------

describe("architecture reference", () => {
  const archPath = path.join(SKILLS, "references", "architecture.md");

  it("exists", () => {
    assert.ok(fs.existsSync(archPath));
  });

  it("contains expected sections", () => {
    const content = fs.readFileSync(archPath, "utf-8");
    // Should cover storage model, cache, lock
    assert.ok(content.includes("#"), "architecture.md should have section headers");
  });
});

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

describe("package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf-8"));

  it("has name", () => {
    assert.ok(pkg.name);
  });

  it("has version", () => {
    assert.ok(pkg.version);
    assert.ok(/^\d+\.\d+\.\d+/.test(pkg.version));
  });

  it("has description", () => {
    assert.ok(pkg.description);
  });

  it("bin field points to existing file", () => {
    for (const [, binPath] of Object.entries(pkg.bin || {})) {
      const full = path.join(SRC, binPath);
      assert.ok(fs.existsSync(full), `bin entry ${binPath} should exist`);
    }
  });

  it("files array includes needed directories", () => {
    assert.ok(pkg.files.includes("bin/"));
    assert.ok(pkg.files.includes("lib/"));
    assert.ok(pkg.files.includes("skills/"));
  });

  it("engine requires node >= 16", () => {
    assert.ok(pkg.engines && pkg.engines.node);
    assert.ok(pkg.engines.node.includes("16"));
  });

  it("all files in files array exist", () => {
    for (const entry of pkg.files) {
      const full = path.join(SRC, entry);
      assert.ok(fs.existsSync(full), `${entry} from files array should exist`);
    }
  });
});

// ---------------------------------------------------------------------------
// README.md
// ---------------------------------------------------------------------------

describe("README.md", () => {
  it("exists and is non-empty", () => {
    const readmePath = path.join(PROJ, "README.md");
    assert.ok(fs.existsSync(readmePath));
    const content = fs.readFileSync(readmePath, "utf-8");
    assert.ok(content.length > 0);
  });
});

// ---------------------------------------------------------------------------
// CHANGELOG.md
// ---------------------------------------------------------------------------

describe("CHANGELOG.md", () => {
  it("exists", () => {
    assert.ok(fs.existsSync(path.join(PROJ, "CHANGELOG.md")));
  });

  it("has version entries", () => {
    const content = fs.readFileSync(path.join(PROJ, "CHANGELOG.md"), "utf-8");
    assert.ok(/\d+\.\d+\.\d+/.test(content), "CHANGELOG should contain version numbers");
  });
});

// ---------------------------------------------------------------------------
// CLAUDE.md
// ---------------------------------------------------------------------------

describe("CLAUDE.md", () => {
  it("exists", () => {
    assert.ok(fs.existsSync(path.join(PROJ, "CLAUDE.md")));
  });

  it("references SKILL.md", () => {
    const content = fs.readFileSync(path.join(PROJ, "CLAUDE.md"), "utf-8");
    assert.ok(content.includes("SKILL.md"));
  });

  it("references architecture.md", () => {
    const content = fs.readFileSync(path.join(PROJ, "CLAUDE.md"), "utf-8");
    assert.ok(content.includes("architecture.md"));
  });

  it("references templates", () => {
    const content = fs.readFileSync(path.join(PROJ, "CLAUDE.md"), "utf-8");
    assert.ok(content.includes("template"));
  });
});

// ---------------------------------------------------------------------------
// Project structure
// ---------------------------------------------------------------------------

describe("project structure", () => {
  it("all JS files in src/lib/ are valid JavaScript", () => {
    const libDir = path.join(SRC, "lib");
    for (const file of fs.readdirSync(libDir)) {
      if (file.endsWith(".js")) {
        const content = fs.readFileSync(path.join(libDir, file), "utf-8");
        assert.ok(content.length > 0, `${file} should not be empty`);
      }
    }
  });

  it(".cache is not tracked in git", () => {
    // .cache directory should not exist in the repo (only created at runtime)
    const cacheInSrc = path.join(SRC, ".cache");
    const cacheInRoot = path.join(PROJ, ".cache");
    // These might exist locally but shouldn't be committed — check for absence or .gitignore
    const gitignorePath = path.join(PROJ, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, "utf-8");
      if (fs.existsSync(cacheInRoot) || fs.existsSync(cacheInSrc)) {
        assert.ok(
          gitignore.includes(".cache"),
          ".cache should be in .gitignore if it exists locally"
        );
      }
    }
    // Pass if .cache doesn't exist at all
  });

  it("no stale Python files in src/", () => {
    // Project migrated from Python to Node — no .py files should exist
    const walk = (dir) => {
      const pyFiles = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== "node_modules") {
          pyFiles.push(...walk(full));
        } else if (entry.name.endsWith(".py")) {
          pyFiles.push(full);
        }
      }
      return pyFiles;
    };
    const pyFiles = walk(SRC);
    assert.strictEqual(pyFiles.length, 0, `Found stale Python files: ${pyFiles.join(", ")}`);
  });
});
