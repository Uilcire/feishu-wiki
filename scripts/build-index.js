#!/usr/bin/env node
/**
 * build-index.js — 后台索引构建
 *
 * 由 core.js 的 spawnBackgroundBuild() 以 detached 子进程方式启动。
 * 父进程通过 AI_WIKI_CACHE_DIR 环境变量传递缓存路径。
 * 写入 .building 标记，构建完成后删除。
 */

const fs = require("fs");

// core.js 在 require 时根据 AI_WIKI_CACHE_DIR 环境变量确定缓存路径
const core = require("../lib/core");
const BUILDING_FILE = core.BUILDING_FILE;

fs.mkdirSync(core.CACHE_DIR, { recursive: true });
fs.writeFileSync(BUILDING_FILE, String(process.pid), "utf-8");

try {
  core._buildIndexSync();
} catch (err) {
  process.stderr.write(`[fw] 后台索引构建失败: ${err.message}\n`);
} finally {
  try {
    fs.unlinkSync(BUILDING_FILE);
  } catch {
    // ignore
  }
}
