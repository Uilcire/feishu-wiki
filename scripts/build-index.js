#!/usr/bin/env node
/**
 * build-index.js — 后台索引构建
 *
 * 由 core.js 的 ensureCache() 以 detached 子进程方式启动。
 * 写入 .cache/.building 标记，构建完成后删除。
 */

const path = require("path");
const fs = require("fs");

const CACHE_DIR = path.resolve(".cache");
const BUILDING_FILE = path.join(CACHE_DIR, ".building");

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.writeFileSync(BUILDING_FILE, String(process.pid), "utf-8");

try {
  // core.js 会在 require 时初始化常量，基于 cwd 解析 .cache 路径
  const core = require("../lib/core");
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
