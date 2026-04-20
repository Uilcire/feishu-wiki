/**
 * import.js — 批量导入云空间文档到知识库
 *
 * 三步流程：scan（扫描云空间文件夹）→ 人/Agent 编辑候选 JSON → apply（搬入 wiki）。
 */

const fs = require("fs");
const path = require("path");

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, p.slice(1));
  }
  return p;
}

/**
 * 扫描云空间文件夹，返回平铺的 docx 列表。
 * 目前只收录 docx（sheet/bitable/file 等类型暂不支持自动迁入 wiki，跳过）。
 * @returns {Array<{token, obj_type, title, parent_path, url}>}
 */
function scanDriveFolder(folderToken, { recursive = true } = {}, deps = {}) {
  const lark = deps.lark || require("./lark");
  const results = [];
  const queue = [{ token: folderToken, pathSegs: [] }];
  const seen = new Set();

  while (queue.length > 0) {
    const { token, pathSegs } = queue.shift();
    if (seen.has(token)) continue;
    seen.add(token);

    const children = lark.listDriveChildren(token) || [];
    for (const child of children) {
      const segs = pathSegs.concat(child.name || "");
      if (child.type === "folder") {
        if (recursive) queue.push({ token: child.token, pathSegs: segs });
        continue;
      }
      if (child.type !== "docx") {
        // sheet/bitable/file/mindnote 暂不纳入批量导入
        continue;
      }
      results.push({
        token: child.token,
        obj_type: child.type,
        title: child.name || "",
        parent_path: pathSegs.join("/"),
        url: child.url || "",
      });
    }
  }
  return results;
}

function _defaultEntry(scanned) {
  return {
    token: scanned.token,
    title: scanned.title,
    obj_type: scanned.obj_type,
    parent_path: scanned.parent_path,
    url: scanned.url,
    relevant: null,
    reason: "",
    approved: false,
    imported_at: null,
    new_wiki_url: null,
    error: null,
  };
}

function loadCandidates(candidatesPath, { strict = false } = {}) {
  const p = expandHome(candidatesPath);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf-8");
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      if (strict) {
        throw new Error(
          `candidates file is not a JSON array (got ${typeof data}): ${p}`
        );
      }
      return [];
    }
    return data;
  } catch (err) {
    if (strict) {
      throw new Error(
        `candidates file is corrupt or invalid JSON (${p}): ${err.message}`
      );
    }
    return [];
  }
}

function saveCandidates(candidatesPath, entries) {
  const p = expandHome(candidatesPath);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: write to sibling tmp then rename so a crash mid-write never
  // truncates an existing valid file.
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
  try {
    fs.renameSync(tmp, p);
  } catch (err) {
    // Best-effort cleanup; re-throw so caller sees the failure.
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * 幂等合并：已存在的条目保留用户判断（relevant/reason/approved/imported_at/new_wiki_url），
 * 新条目写入默认值。返回合并后的新数组（不修改入参）。
 */
function mergeCandidates(existing, scanned) {
  const byToken = new Map();
  // 对 existing 也按 token 去重：同一 token 只保留首次出现的条目。
  for (const e of existing || []) {
    if (e && e.token && !byToken.has(e.token)) byToken.set(e.token, e);
  }
  const merged = [];
  const seen = new Set();
  for (const s of scanned || []) {
    if (!s || !s.token) continue;
    // scanned 内部同一 token 只处理一次，防止产生重复条目。
    if (seen.has(s.token)) continue;
    const prev = byToken.get(s.token);
    if (prev) {
      merged.push({
        ...prev,
        // 元数据以最新扫描为准（可能重命名、移动）
        title: s.title || prev.title,
        obj_type: s.obj_type || prev.obj_type,
        parent_path: s.parent_path !== undefined ? s.parent_path : prev.parent_path,
        url: s.url || prev.url,
      });
    } else {
      merged.push(_defaultEntry(s));
    }
    seen.add(s.token);
  }
  // 保留已扫描集合之外的旧条目（例如已导入但当前扫描没覆盖到的）；
  // 同时对 existing 内部的重复 token 去重。
  const keptExisting = new Set();
  for (const e of existing || []) {
    if (!e || !e.token) continue;
    if (seen.has(e.token)) continue;
    if (keptExisting.has(e.token)) continue;
    keptExisting.add(e.token);
    merged.push(e);
  }
  return merged;
}

/**
 * 执行导入：对 approved=true 且未导入的条目调用 moveDocToWiki，
 * 原地更新 imported_at/new_wiki_url/error，并在每次成功后落盘。
 */
function applyImport({ candidatesPath, destinationNodeToken, spaceId, dryRun = false }, deps = {}) {
  const lark = deps.lark || require("./lark");
  // strict=true：拒绝在畸形/损坏的候选文件上静默以 [] 覆盖，避免数据丢失。
  const entries = loadCandidates(candidatesPath, { strict: true });
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.approved) {
      skipped++;
      continue;
    }
    if (entry.imported_at) {
      skipped++;
      continue;
    }
    attempted++;
    if (dryRun) {
      continue;
    }
    try {
      const res = lark.moveDocToWiki(
        entry.obj_type,
        entry.token,
        destinationNodeToken,
        spaceId
      );
      if (res && res.ok && res.node_token) {
        entry.imported_at = new Date().toISOString();
        entry.new_wiki_url = `https://feishu.cn/wiki/${res.node_token}`;
        entry.error = null;
        succeeded++;
        saveCandidates(candidatesPath, entries);
      } else {
        // 统一失败路径：异步任务未完成 (res.pending)、缺 node_token、或 ok:false。
        // 不标记 imported_at —— 允许下次 apply 重试。
        let errStr = (res && res.error) || "未知错误";
        if (typeof errStr === "object") {
          errStr = errStr.message || JSON.stringify(errStr);
        }
        entry.error = String(errStr);
        if (res && res.pending && res.task_id) {
          entry.pending_task_id = res.task_id;
        }
        failed++;
        saveCandidates(candidatesPath, entries);
      }
    } catch (err) {
      entry.error = err.message || String(err);
      failed++;
      saveCandidates(candidatesPath, entries);
    }
  }
  if (!dryRun) saveCandidates(candidatesPath, entries);
  return { attempted, succeeded, failed, skipped };
}

module.exports = {
  scanDriveFolder,
  loadCandidates,
  saveCandidates,
  mergeCandidates,
  applyImport,
  expandHome,
};
