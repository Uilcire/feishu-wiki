/**
 * lark.js — lark-cli 子进程封装
 *
 * 所有 lark-cli 交互集中在此模块。
 */

const { execFileSync } = require("child_process");

/**
 * 执行 lark-cli 命令，返回解析后的 JSON。
 * @param {string[]} args - lark-cli 参数
 * @param {object} opts
 * @param {boolean} [opts.check=false] - 失败时是否抛异常
 * @param {number} [opts.timeout=30000] - 超时毫秒
 * @returns {object|null}
 */
function run(args, { check = false, timeout = 30000 } = {}) {
  try {
    const stdout = execFileSync("lark-cli", args, {
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
};
