#!/usr/bin/env node
/**
 * npm postinstall — 注册 skill 到所有检测到的 Agent 环境
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SKILL_NAME = "ai-wiki";
const OLD_SKILL_NAME = "feishu-wiki";
const SKILLS_SRC = path.join(__dirname, "..", "skills");

function which(cmd) {
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function copySkill(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  // Copy SKILL.md
  const skillMd = path.join(SKILLS_SRC, "SKILL.md");
  if (fs.existsSync(skillMd)) {
    fs.copyFileSync(skillMd, path.join(targetDir, "SKILL.md"));
  }

  // Copy subdirectories: templates/, references/, agents/
  for (const subdir of ["templates", "references", "agents"]) {
    const src = path.join(SKILLS_SRC, subdir);
    const dst = path.join(targetDir, subdir);
    if (fs.existsSync(src)) {
      fs.rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst);
    }
  }
}

function cpSync(src, dst) {
  // fs.cpSync requires Node 16.7+, fallback for older versions
  if (fs.cpSync) {
    fs.cpSync(src, dst, { recursive: true });
  } else {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        cpSync(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }
}

function cleanOldSkill(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ensureSymlink(target, linkPath) {
  // 清理旧的（无论是文件、目录还是旧 symlink）
  if (fs.existsSync(linkPath) || isSymlink(linkPath)) {
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, "dir");
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function main() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return;

  const registered = [];

  // 1. 主目录：~/.agents/skills/ai-wiki/（文件实体）
  const canonicalDir = path.join(home, ".agents", "skills", SKILL_NAME);
  cleanOldSkill(path.join(home, ".agents", "skills", OLD_SKILL_NAME));
  copySkill(canonicalDir);
  registered.push(`~/.agents/skills/${SKILL_NAME} (主目录)`);

  // 2. Claude Code: ~/.claude/skills/ai-wiki → symlink
  const claudeDir = path.join(home, ".claude");
  if (fs.existsSync(claudeDir) || which("claude")) {
    const linkPath = path.join(claudeDir, "skills", SKILL_NAME);
    cleanOldSkill(path.join(claudeDir, "skills", OLD_SKILL_NAME));
    ensureSymlink(canonicalDir, linkPath);
    registered.push(`~/.claude/skills/${SKILL_NAME} → symlink`);
  }

  // 3. Codex: ~/.codex/skills/ai-wiki → symlink
  const codexDir = path.join(home, ".codex");
  if (fs.existsSync(codexDir) || which("codex")) {
    const linkPath = path.join(codexDir, "skills", SKILL_NAME);
    cleanOldSkill(path.join(codexDir, "skills", OLD_SKILL_NAME));
    ensureSymlink(canonicalDir, linkPath);
    registered.push(`~/.codex/skills/${SKILL_NAME} → symlink`);
  }

  // 4. Smoke test：验证安装完整性
  const errors = [];
  const skillMdPath = path.join(canonicalDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    errors.push("SKILL.md 不存在");
  } else {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    if (!content.includes("name: ai-wiki")) {
      errors.push("SKILL.md 缺少 frontmatter");
    }
  }
  // 验证 symlink 可读
  for (const dir of [claudeDir, codexDir]) {
    const link = path.join(dir, "skills", SKILL_NAME, "SKILL.md");
    if (fs.existsSync(link)) {
      try {
        fs.readFileSync(link, "utf-8");
      } catch {
        errors.push(`symlink 不可读: ${link}`);
      }
    }
  }

  if (registered.length) {
    console.log("");
    console.log("  ═══════════════════════════════════════════════════");
    if (errors.length) {
      console.log("  ⚠️  AI Wiki 安装完成，但有问题：");
      for (const e of errors) console.log(`     ❌ ${e}`);
    } else {
      console.log("  ✅ AI Wiki 已安装！");
    }
    console.log("");
    for (const r of registered) {
      console.log(`     → ${r}`);
    }
    console.log("");
    console.log("  打开你的 Agent（Claude Code / Codex），说：");
    console.log('    "帮我查一下 AI Wiki 有什么内容"');
    console.log("");
    console.log("  Agent 会自动引导你完成飞书登录等配置。");
    console.log("  ═══════════════════════════════════════════════════");
    console.log("");
  }
}

main();
