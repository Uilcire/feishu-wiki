/**
 * lark.js — lark-cli 子进程封装
 *
 * 所有 lark-cli 交互集中在此模块。
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// === lark-cli 路径解析 ===

let _resolvedCli = null;

/**
 * 解析 lark-cli 可执行文件的绝对路径。
 * 优先级：LARK_CLI_PATH 环境变量 → PATH 目录扫描 → 常见安装位置。
 * 不使用 which/where 子进程，纯 fs 探测，避免与 execFileSync mock 冲突。
 * 结果缓存，只解析一次。
 */
function resolveLarkCli() {
  if (_resolvedCli) return _resolvedCli;

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const bin = "lark-cli";

  // 1. 环境变量显式指定
  if (process.env.LARK_CLI_PATH) {
    const p = process.env.LARK_CLI_PATH;
    if (fs.existsSync(p)) {
      _resolvedCli = p;
      return _resolvedCli;
    }
  }

  // 2. 扫描 PATH 目录
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) {
      _resolvedCli = candidate;
      return _resolvedCli;
    }
  }

  // 3. 常见安装路径（PATH 可能不包含这些）
  const commonPaths = [
    "/opt/homebrew/bin/lark-cli",
    "/usr/local/bin/lark-cli",
    path.join(home, ".npm-global/bin/lark-cli"),
    path.join(home, ".nvm/versions/node", process.version, "bin/lark-cli"),
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      _resolvedCli = p;
      return _resolvedCli;
    }
  }

  // 4. 兜底：裸名，让 execFileSync 自己报错
  _resolvedCli = bin;
  return _resolvedCli;
}

/**
 * 执行 lark-cli 命令，返回解析后的 JSON。
 * @param {string[]} args - lark-cli 参数
 * @param {object} opts
 * @param {boolean} [opts.check=false] - 失败时是否抛异常
 * @param {number} [opts.timeout=30000] - 超时毫秒
 * @returns {object|null}
 */
function run(args, { check = false, timeout = 30000 } = {}) {
  const cli = resolveLarkCli();
  try {
    const stdout = execFileSync(cli, args, {
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(stdout);
  } catch (err) {
    if (check) {
      const msg = err.stderr
        ? err.stderr.toString().slice(0, 500)
        : err.message.slice(0, 500);
      throw new Error(`lark-cli 失败: ${msg}`);
    }
    return null;
  }
}

/**
 * 判断 lark-cli 返回结果是否成功。
 */
function isSuccess(result) {
  return Boolean(result) && (result.ok || result.code === 0);
}

/**
 * 获取当前 lark-cli 认证用户。
 * @returns {{ name: string, open_id: string }}
 */
let _cachedUser = null;
function currentUser() {
  if (_cachedUser) return _cachedUser;
  try {
    const data = run(["auth", "status"]);
    _cachedUser = {
      name: (data && data.userName) || "unknown",
      open_id: (data && data.userOpenId) || "",
    };
  } catch {
    _cachedUser = { name: "unknown", open_id: "" };
  }
  return _cachedUser;
}

/**
 * 拉取文档正文（Lark-flavored Markdown），带限流重试。
 */
function fetchDocMarkdown(objToken, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = run(
        ["docs", "+fetch", "--as", "user", "--doc", objToken],
        { check: true }
      );
      if (isSuccess(r)) {
        return (r.data && r.data.markdown) || "";
      }
      return "";
    } catch (err) {
      const msg = err.message || "";
      if (
        (msg.includes("frequency limit") || msg.toLowerCase().includes("rate")) &&
        attempt < retries - 1
      ) {
        // 限流，等待后重试
        const ms = 1500 * (attempt + 1);
        const end = Date.now() + ms;
        while (Date.now() < end) {
          // busy wait (sync)
        }
        continue;
      }
      throw err;
    }
  }
  return "";
}

/**
 * 上传（覆盖写入）单个页面到飞书。
 */
function uploadPage(title, objToken, content) {
  const r = run(
    [
      "docs", "+update", "--as", "user",
      "--doc", objToken,
      "--mode", "overwrite",
      "--markdown", content,
    ],
    { check: true }
  );
  if (!isSuccess(r)) {
    throw new Error(`上传失败 ${title}: ${JSON.stringify(r)}`);
  }
}

/**
 * 列出某节点的直接子节点（自动分页）。
 */
function listChildren(nodeToken, spaceId) {
  const children = [];
  let pageToken = "";
  while (true) {
    const params = {
      parent_node_token: nodeToken,
      space_id: spaceId,
      page_size: 50,
    };
    if (pageToken) params.page_token = pageToken;
    const r = run([
      "wiki", "nodes", "list", "--as", "user",
      "--params", JSON.stringify(params),
    ]);
    if (!isSuccess(r)) break;
    const data = r.data || {};
    children.push(...(data.items || []));
    if (!data.has_more) break;
    pageToken = data.page_token || "";
    if (!pageToken) break;
  }
  return children;
}

module.exports = {
  run,
  isSuccess,
  currentUser,
  fetchDocMarkdown,
  uploadPage,
  listChildren,
  resolveLarkCli,
};
