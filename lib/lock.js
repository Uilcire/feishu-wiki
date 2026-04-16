/**
 * lock.js — 基于飞书 Queue 页面的分布式 FIFO 写锁
 *
 * 机制：
 *   - 飞书知识库中有一个特殊页面「队列」作为 FIFO 锁
 *   - 每行格式：name|timestamp
 *   - 队首 = 持锁人
 *   - 写入前：追加自己到队尾 → 轮询（15s）直到自己在队首
 *   - 写完后：移除自己（队首）
 *   - 超时 5 分钟的条目自动清理（防死锁）
 */

const lark = require("./lark");

// 锁配置
const POLL_INTERVAL = 15000; // ms
const LOCK_TIMEOUT = 300;    // seconds

// 会话级锁状态
let _lockHeld = false;

function isLocked() {
  return _lockHeld;
}

function _getQueueInfo() {
  const core = require("./core");
  core.ensureCache();
  const index = core.loadIndex();

  // 检查 special_docs
  if (index.special_docs && index.special_docs["队列"]) {
    return index.special_docs["队列"];
  }

  // 检查 pages
  if (index.pages && index.pages["队列"]) {
    return index.pages["队列"];
  }

  // 创建 Queue 页面
  const rootNodeToken = (index.root || {}).node_token;
  if (!rootNodeToken) {
    throw new Error("无法找到 wiki root node，无法创建队列页面");
  }

  const r = lark.run(
    [
      "docs", "+create", "--as", "user",
      "--wiki-node", rootNodeToken,
      "--title", "队列",
      "--markdown", "# 写入队列\n\n",
    ],
    { check: true }
  );
  if (!lark.isSuccess(r)) {
    throw new Error(`创建队列页面失败: ${JSON.stringify(r)}`);
  }

  const data = r.data || {};
  const docId = data.doc_id;
  const docUrl = data.doc_url || "";
  const nodeToken = docUrl.includes("/wiki/") ? docUrl.split("/").pop() : "";

  const queueInfo = {
    obj_token: docId,
    node_token: nodeToken,
    url: docUrl,
  };

  if (!index.special_docs) index.special_docs = {};
  index.special_docs["队列"] = queueInfo;
  core.saveIndex(index);

  process.stderr.write("[fw] 已创建队列页面\n");
  return queueInfo;
}

function _readQueue(objToken) {
  const md = lark.fetchDocMarkdown(objToken);
  const entries = [];
  for (const line of md.trim().split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes("|") && !trimmed.startsWith("#")) {
      const parts = trimmed.split("|", 2);
      if (parts.length === 2) {
        entries.push([parts[0].trim(), parts[1].trim()]);
      }
    }
  }
  return entries;
}

function _writeQueue(objToken, entries) {
  const lines = ["# 写入队列\n"];
  for (const [name, ts] of entries) {
    lines.push(`${name}|${ts}`);
  }
  const content = lines.join("\n") + "\n";

  const r = lark.run(
    [
      "docs", "+update", "--as", "user",
      "--doc", objToken,
      "--mode", "overwrite",
      "--markdown", content,
    ],
    { check: true }
  );
  if (!lark.isSuccess(r)) {
    throw new Error(`写入队列失败: ${JSON.stringify(r)}`);
  }
}

function _cleanExpired(entries) {
  const now = Date.now();
  return entries.filter(([name, ts]) => {
    try {
      const entryTime = new Date(ts).getTime();
      if ((now - entryTime) / 1000 >= LOCK_TIMEOUT) {
        process.stderr.write(`[fw] 锁超时，自动清理: ${name} (${ts})\n`);
        return false;
      }
      return true;
    } catch {
      return false; // 无法解析时间戳，跳过
    }
  });
}

function _sleepSync(ms) {
  // 用 Atomics.wait 实现零 CPU 同步等待，代替忙等待
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function _acquire(objToken, userName) {
  const now = new Date().toISOString();

  let entries = _readQueue(objToken);
  entries = _cleanExpired(entries);
  entries.push([userName, now]);
  _writeQueue(objToken, entries);

  while (true) {
    entries = _readQueue(objToken);
    const beforeLen = entries.length;
    entries = _cleanExpired(entries);

    if (!entries.length) {
      const freshNow = new Date().toISOString();
      entries.push([userName, freshNow]);
      _writeQueue(objToken, entries);
      continue;
    }

    // 只在清理了过期条目时才写回，减少不必要的子进程调用
    if (entries.length < beforeLen) {
      _writeQueue(objToken, entries);
    }

    if (entries[0][0] === userName) {
      process.stderr.write(`[fw] 🔒 已获取写锁 (${userName})\n`);
      return;
    }

    process.stderr.write(
      `[fw] 等待写锁... 队列: ${JSON.stringify(entries.map(([n]) => n))}\n`
    );
    _sleepSync(POLL_INTERVAL);
  }
}

function _release(objToken, userName) {
  let entries = _readQueue(objToken);
  entries = _cleanExpired(entries);

  if (entries.length && entries[0][0] === userName) {
    entries.shift();
  } else {
    entries = entries.filter(([n]) => n !== userName);
  }

  _writeQueue(objToken, entries);
  process.stderr.write(`[fw] 🔓 已释放写锁 (${userName})\n`);
}

/**
 * 在锁内执行函数。
 * @param {Function} fn
 * @returns {*} fn 的返回值
 */
function withLock(fn) {
  if (_lockHeld) return fn();

  const core = require("./core");
  core.ensureCache();

  const queueInfo = _getQueueInfo();
  const objToken = queueInfo.obj_token;
  const user = lark.currentUser();
  const userName = user.name || "unknown";

  _acquire(objToken, userName);
  _lockHeld = true;

  try {
    return fn();
  } finally {
    _lockHeld = false;
    try {
      core.sync();
    } catch (e) {
      process.stderr.write(`[fw] 锁内 sync 失败: ${e.message}\n`);
    }
    _release(objToken, userName);
  }
}

module.exports = { isLocked, withLock };
