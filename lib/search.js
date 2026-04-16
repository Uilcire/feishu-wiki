/**
 * search.js — 本地 grep + 飞书 API 搜索
 */

const fs = require("fs");
const lark = require("./lark");
const core = require("./core");

// 会话级 wiki token 缓存
let _wikiTokensCache = null;

function _getWikiTokens() {
  if (_wikiTokensCache) return _wikiTokensCache;
  const index = core.loadIndex();
  if (index && Object.keys(index.pages || {}).length > 0) {
    _wikiTokensCache = new Set();
    for (const info of Object.values(index.pages)) {
      if (info.obj_token) _wikiTokensCache.add(info.obj_token);
    }
  } else {
    _wikiTokensCache = core.loadWikiTokensFromCloud(); // returns Set or null
  }
  return _wikiTokensCache;
}

/**
 * 在已缓存的页面正文中搜索关键词。
 * 只搜索本地已缓存的页面。未 fetch 过的页面不会被搜索到。
 */
function grep(pattern, { category = null, ignoreCase = true } = {}) {
  core.ensureCache();

  let flags = ignoreCase ? "gi" : "g";
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }

  const results = [];
  for (const page of core.listPages({ category })) {
    const cachePath = core.docCachePath(page.title);
    if (!fs.existsSync(cachePath)) continue;
    const content = fs.readFileSync(cachePath, "utf-8");
    if (!content) continue;

    const lines = content.split("\n");
    const hits = [];
    lines.forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) {
        hits.push({ line: i + 1, text: line.trim().slice(0, 120) });
      }
    });

    if (hits.length) {
      results.push({
        title: page.title,
        category: page.category || "",
        matches: hits,
      });
    }
  }

  results.sort((a, b) => b.matches.length - a.matches.length);
  return results;
}

/**
 * 通过飞书搜索 API 全文检索文档。
 * 默认只搜索 wiki 内的页面（wikiOnly=true）。
 * 传 allDocs=true 时搜索整个飞书云文档。
 */
function searchFeishu(keyword, { limit = 10, allDocs = false } = {}) {
  process.stderr.write(`[fw] 正在搜索: ${keyword}...\n`);
  const r = lark.run([
    "docs", "+search", "--as", "user",
    "--query", keyword,
    "--page-size", String(Math.min(limit, 20)),
  ]);
  if (!lark.isSuccess(r)) return [];

  // 获取 wiki 的 obj_tokens 用于过滤（会话内缓存）
  const wikiTokens = _getWikiTokens();

  const results = [];
  for (const item of (r.data && r.data.results) || []) {
    const meta = item.result_meta || {};
    const token = meta.token || "";
    const isWiki = wikiTokens ? wikiTokens.has(token) : true;

    // 默认只返回 wiki 内的结果（无 token 清单时返回全部）
    if (!allDocs && !isWiki) continue;

    const title = (item.title_highlighted || "").replace(/<\/?h>/g, "");
    const summary = (item.summary_highlighted || "").replace(/<\/?h>/g, "");

    results.push({
      title,
      summary,
      url: meta.url || "",
      type: item.entity_type || "",
      owner: meta.owner_name || "",
      updated: (meta.update_time_iso || "").slice(0, 10),
      token,
      is_wiki: isWiki,
    });
  }
  return results;
}

module.exports = { grep, searchFeishu };
