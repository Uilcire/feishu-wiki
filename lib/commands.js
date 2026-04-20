/**
 * commands.js — CLI 命令路由
 */

const fs = require("fs");
const path = require("path");

function json(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function parseArgs(argv) {
  const cmd = argv[0] || "";
  const rest = argv.slice(1);

  // 解析 --key value 和 positional args
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i].startsWith("--") && i + 1 < rest.length) {
      const key = rest[i].slice(2);
      flags[key] = rest[i + 1];
      i += 2;
    } else if (rest[i].startsWith("--")) {
      // boolean flag
      flags[rest[i].slice(2)] = true;
      i++;
    } else {
      positional.push(rest[i]);
      i++;
    }
  }

  return { cmd, flags, positional, query: positional.join(" ") };
}

function main(argv) {
  const { cmd, flags, positional, query } = parseArgs(argv);

  // --help / -h 顶层别名：无论出现在哪个位置都等价于 help
  if (cmd === "--help" || cmd === "-h" || "help" in flags || "h" in flags) {
    showHelp();
    return;
  }

  switch (cmd) {
    case "":
    case "help":
      showHelp();
      break;

    case "find": {
      if (!query) {
        console.error("用法: ai-wiki find <query> [--category CAT]");
        process.exit(1);
      }
      const core = require("./core");
      const result = core.find(query, { category: flags.category || null });
      if (result) json(result);
      else {
        console.error(`未找到页面: ${query}`);
        process.exit(1);
      }
      break;
    }

    case "list": {
      const core = require("./core");
      const pages = core.listPages({ category: flags.category || null });
      const meta = core.lastIndexMeta;
      json({ results: pages, freshness: meta.freshness, data_source: meta.data_source });
      break;
    }

    case "fetch": {
      if (!query) {
        console.error("用法: ai-wiki fetch <title> [--fresh] [--head] [--section NAME] [--excerpt KEYWORD] [--window N] [--raw]");
        process.exit(1);
      }
      const core = require("./core");
      const freshFlag = "fresh" in flags;

      if ("head" in flags) {
        const meta = core.fetchHead(query, { fresh: freshFlag });
        // Include freshness in --head output
        const fetchMeta = core.lastFetchMeta;
        if (fetchMeta) {
          meta.freshness = fetchMeta.freshness;
          meta.data_source = fetchMeta.data_source;
        }
        json(meta);
      } else if (flags.section) {
        try {
          const section = core.fetchSection(query, flags.section, { fresh: freshFlag });
          console.log(section);
        } catch (e) {
          console.error(e.message);
          process.exit(1);
        }
      } else if (flags.excerpt) {
        const windowSize = flags.window ? parseInt(flags.window, 10) : 5;
        try {
          const excerpt = core.fetchExcerpt(query, flags.excerpt, { fresh: freshFlag, window: windowSize });
          console.log(excerpt);
        } catch (e) {
          console.error(e.message);
          process.exit(1);
        }
      } else {
        // Default / --raw: full markdown
        try {
          const content = core.fetch(query, { fresh: freshFlag });
          console.log(content);
        } catch (e) {
          console.error(`错误: ${e.message}`);
          process.exit(1);
        }
        const fetchMeta = core.lastFetchMeta;
        if (fetchMeta) {
          process.stderr.write(
            `[fw] freshness=${fetchMeta.freshness} data_source=${fetchMeta.data_source}\n`
          );
        }
      }
      break;
    }

    case "link": {
      if (!query) {
        console.error("用法: ai-wiki link <title>");
        process.exit(1);
      }
      const core = require("./core");
      try {
        console.log(core.link(query));
      } catch (e) {
        console.error(`错误: ${e.message}`);
        process.exit(1);
      }
      break;
    }

    case "grep": {
      if (!query) {
        console.error("用法: ai-wiki grep <pattern> [--category CAT]");
        process.exit(1);
      }
      const search = require("./search");
      const grepResult = search.grep(query, { category: flags.category || null });
      json(grepResult);
      break;
    }

    case "search": {
      if (!query) {
        console.error("用法: ai-wiki search <query> [--all-docs]");
        process.exit(1);
      }
      const search = require("./search");
      const searchResult = search.searchFeishu(query, { allDocs: "all-docs" in flags });
      json(searchResult);
      break;
    }

    case "create": {
      if (!flags.category || !flags.title) {
        console.error(
          "用法: ai-wiki create --category CAT --title TITLE [--summary S] <<< content"
        );
        process.exit(1);
      }
      const content = readStdin();
      if (!content.trim()) {
        console.error("错误: 内容为空（通过 stdin 传入）");
        process.exit(1);
      }
      const core = require("./core");
      json(core.create(flags.category, flags.title, content, {
        summary: flags.summary || "",
        force: "force" in flags,
      }));
      break;
    }

    case "write":
    case "update": {
      if (!query) {
        console.error("用法: ai-wiki update <title> [--mode append|overwrite] <<< content");
        process.exit(1);
      }
      const content = readStdin();
      if (!content.trim()) {
        console.error("错误: 内容为空（通过 stdin 传入）");
        process.exit(1);
      }
      const core = require("./core");
      core.update(query, content, { mode: flags.mode || "append", force: "force" in flags });
      json({ ok: true, title: query, mode: flags.mode || "append" });
      break;
    }

    case "delete": {
      if (!query) {
        console.error("用法: ai-wiki delete <title> [--reason REASON]");
        process.exit(1);
      }
      const core = require("./core");
      core.del(query, { reason: flags.reason || "", force: "force" in flags });
      json({ ok: true, title: query, action: "deprecated" });
      break;
    }

    case "status": {
      const core = require("./core");
      json(core.status());
      break;
    }

    case "sync": {
      const core = require("./core");
      json(core.sync());
      break;
    }

    case "refresh": {
      const core = require("./core");
      core.refresh();
      json({ ok: true });
      break;
    }

    case "lint": {
      const core = require("./core");
      if (flags.title) {
        json(core.verifyWrite(flags.title));
      } else {
        json(core.lint());
      }
      break;
    }

    case "verify-write": {
      if (!query) {
        console.error("用法: ai-wiki verify-write <title>");
        process.exit(1);
      }
      const core = require("./core");
      json(core.verifyWrite(query));
      break;
    }

    case "user": {
      const lark = require("./lark");
      json(lark.currentUser());
      break;
    }

    case "mode": {
      handleMode(positional[0], flags);
      break;
    }

    case "feedback": {
      if (!query) {
        console.error('用法: ai-wiki feedback "你的反馈内容"');
        process.exit(1);
      }
      const core = require("./core");
      const result = core.feedback(query);
      if (result.ok) {
        console.log("  ✅ 反馈已提交！");
      } else {
        console.error(`  ❌ 提交失败: ${result.error}`);
      }
      break;
    }

    case "setup": {
      runSetup();
      break;
    }

    case "log-qa": {
      // Agent 调用：ai-wiki log-qa --json '{"question":"...","answer":"...","tools":[...]}'
      const core = require("./core");
      let data;
      try {
        data = JSON.parse(flags.json || readStdin());
      } catch {
        console.error("错误: 无效的 JSON 输入");
        process.exit(1);
      }
      json(core.logQa(data.question, data.answer, data.tools));
      break;
    }

    case "import": {
      handleImport(positional, flags);
      break;
    }

    case "upgrade":
    case "self-update": {
      runUpgrade(flags);
      break;
    }

    default:
      console.error(`未知命令: ${cmd}`);
      console.error("运行 ai-wiki help 查看可用命令");
      process.exit(1);
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function handleMode(subCmd) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const configPath = path.join(home, ".feishu-wiki-config.json");

  function getConfig() {
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch {
        // ignore
      }
    }
    return { write_enabled: false };
  }

  if (!subCmd) {
    const cfg = getConfig();
    const current = cfg.write_enabled ? "贡献模式（读写）" : "学习模式（只读）";
    console.log(`  当前模式：${current}`);
    console.log();
    console.log("  切换：ai-wiki mode read   → 学习模式");
    console.log("        ai-wiki mode write  → 贡献模式");
  } else if (subCmd === "write" || subCmd === "贡献") {
    fs.writeFileSync(configPath, JSON.stringify({ write_enabled: true }, null, 2));
    console.log("  ✅ 已切换到贡献模式（读写）");
  } else if (subCmd === "read" || subCmd === "学习") {
    fs.writeFileSync(configPath, JSON.stringify({ write_enabled: false }, null, 2));
    console.log("  ✅ 已切换到学习模式（只读）");
  } else {
    console.error(`  未知模式: ${subCmd}，可选: read / write`);
    process.exit(1);
  }
}

function runSetup() {
  const { execFileSync } = require("child_process");
  const which = (cmd) => {
    try {
      execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  };

  console.log("═".repeat(55));
  console.log("  ai-wiki setup");
  console.log("═".repeat(55));

  // 1. Check lark-cli
  console.log("\n  [1/3] 检查 lark-cli...");
  const lark = require("./lark");
  const cliPath = lark.resolveLarkCli();
  if (cliPath !== "lark-cli") {
    console.log(`  ✅ lark-cli 已安装（${cliPath}）`);
  } else if (which("lark-cli")) {
    console.log("  ✅ lark-cli 已安装");
  } else {
    console.log("  ❌ 未检测到 lark-cli，正在安装...");
    try {
      execFileSync("npm", ["install", "-g", "@larksuite/cli"], {
        stdio: "inherit",
      });
      console.log("  ✅ lark-cli 已安装");
    } catch {
      console.error("  ❌ lark-cli 安装失败，请手动安装：");
      console.error("     npm install -g @larksuite/cli");
      process.exit(1);
    }
  }

  // 2. Check auth
  console.log("\n  [2/3] 检查飞书登录...");
  try {
    const user = lark.currentUser();
    if (user.name && user.name !== "unknown") {
      console.log(`  ✅ 已登录：${user.name}`);
    } else {
      throw new Error("not logged in");
    }
  } catch {
    console.log("  未登录，正在启动飞书授权...");
    const scopes = "drive:drive drive:drive:readonly space:document:retrieve wiki:wiki wiki:node:move base:record:write";
    try {
      execFileSync(cliPath, ["auth", "login", "--scope", scopes], { stdio: "inherit" });
      console.log("  ✅ 登录成功");
    } catch {
      console.error(`  ❌ 登录失败，请手动执行：lark-cli auth login --scope "${scopes}"`);
      process.exit(1);
    }
  }

  // 3. Verify
  console.log("\n  [3/3] 验证连接...");
  try {
    const core = require("./core");
    const st = core.status();
    if (st.cache === "ready") {
      console.log(`  ✅ 连接成功！AI Wiki 共 ${st.pages} 个页面`);
    } else {
      core.refresh();
      // refresh 完成后索引已就绪，直接读 loadIndex 拿页面数，避免多余的 status() 调用
      const index = core.loadIndex();
      const pageCount = index ? Object.keys(index.pages || {}).length : 0;
      console.log(`  ✅ 连接成功！AI Wiki 共 ${pageCount} 个页面`);
    }
  } catch (e) {
    console.error(`  ❌ 验证失败: ${e.message}`);
  }

  console.log("\n" + "═".repeat(55));
  console.log("  ✅ 设置完成！");
  console.log();
  console.log("  告诉你的 Agent：");
  console.log('    "帮我查一下 AI Wiki 有什么内容"');
  console.log("═".repeat(55));
}

function runUpgrade(flags) {
  const { execFileSync } = require("child_process");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
  );
  const current = pkg.version || "0.0.0";

  // 1. Check latest version on npm
  console.log("  检查最新版本...");
  let latest;
  try {
    latest = execFileSync("npm", ["view", "@uilcire/ai-wiki", "version"], {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    console.error("  ❌ 无法检查更新（离线或 npm 不可用）");
    console.error("  手动更新：npm install -g @uilcire/ai-wiki@latest");
    process.exit(1);
  }

  console.log(`  当前版本：${current}`);
  console.log(`  最新版本：${latest}`);

  if (current === latest) {
    console.log("  ✅ 已是最新版本");
    return;
  }

  // 2. Compare semver (simple string compare for a.b.c)
  const cParts = current.split(".").map(Number);
  const lParts = latest.split(".").map(Number);
  const isAhead =
    cParts[0] > lParts[0] ||
    (cParts[0] === lParts[0] && cParts[1] > lParts[1]) ||
    (cParts[0] === lParts[0] && cParts[1] === lParts[1] && cParts[2] > lParts[2]);
  if (isAhead) {
    console.log("  当前版本高于最新发布版（开发版？）");
    return;
  }

  // 3. Run upgrade
  console.log();
  console.log(`  升级 ${current} → ${latest} ...`);
  try {
    execFileSync("npm", ["install", "-g", "@uilcire/ai-wiki@latest"], {
      stdio: "inherit",
      timeout: 60000,
    });
    console.log();
    console.log(`  ✅ 已升级到 ${latest}`);
    if ("check" in flags) {
      // --check flag: just report, don't print restart hint (for agent use)
      json({ upgraded: true, from: current, to: latest });
    }
  } catch (err) {
    console.error("  ❌ 升级失败");
    console.error("  手动更新：npm install -g @uilcire/ai-wiki@latest");
    process.exit(1);
  }
}

function loadImportConfig() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const defaults = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "default-config.json"), "utf-8")
  );
  const userCfg = {};
  const userPath = path.join(home, ".feishu-config.json");
  if (fs.existsSync(userPath)) {
    try {
      Object.assign(userCfg, JSON.parse(fs.readFileSync(userPath, "utf-8")));
    } catch {
      // ignore
    }
  }
  const merged = { ...defaults, ...userCfg };
  const imp = Object.assign({}, defaults.import || {}, userCfg.import || {});
  merged.import = imp;
  return merged;
}

function isWriteEnabled() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const configPath = path.join(home, ".feishu-wiki-config.json");
  if (!fs.existsSync(configPath)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return Boolean(cfg.write_enabled);
  } catch {
    return false;
  }
}

function handleImport(positional, flags) {
  const sub = positional[0];
  if (!sub) {
    console.error("用法: ai-wiki import <scan|list|mark|approve|reject|reset|apply> [...]");
    console.error("  import scan [folder_token]                扫描云空间文件夹（省略则扫「我的空间」根）");
    console.error("  import list [--pending|--approved|--imported|--all]  查看候选");
    console.error("  import mark <token> --relevant true|false [--reason R]  打相关性判断");
    console.error("  import approve <token>... | --all-relevant  批准导入");
    console.error("  import reject <token>...                  拒绝导入");
    console.error("  import reset <token>... | --all           重置判断字段回 pending");
    console.error("  import apply [--dry-run]                  搬入 wiki（需写模式）");
    process.exit(1);
  }

  const cfg = loadImportConfig();
  const importCfg = cfg.import || {};
  const candidatesPath = importCfg.candidates_path;
  if (!candidatesPath) {
    console.error("错误: 配置缺少 import.candidates_path");
    process.exit(1);
  }

  const imp = require("./import");

  if (sub === "scan") {
    const folderToken = positional[1] || "";
    if (!folderToken) {
      process.stderr.write("[fw] 未指定 folder_token，扫描「我的空间」根目录（仅第一页，不含快捷方式）\n");
    }
    const scanned = imp.scanDriveFolder(folderToken, { recursive: true });
    const existing = imp.loadCandidates(candidatesPath);
    const existingTokens = new Set(existing.map((e) => e.token));
    const merged = imp.mergeCandidates(existing, scanned);
    imp.saveCandidates(candidatesPath, merged);
    const newCount = scanned.filter((s) => !existingTokens.has(s.token)).length;
    json({
      scanned: scanned.length,
      new: newCount,
      unchanged: scanned.length - newCount,
      total: merged.length,
      candidates_path: candidatesPath,
    });
    return;
  }

  if (sub === "list") {
    const entries = imp.loadCandidates(candidatesPath);
    let filtered;
    if ("all" in flags) {
      filtered = entries;
    } else if ("pending" in flags) {
      filtered = entries.filter((e) => e.relevant === null);
    } else if ("approved" in flags) {
      filtered = entries.filter((e) => e.approved === true);
    } else if ("imported" in flags) {
      filtered = entries.filter((e) => Boolean(e.imported_at));
    } else {
      // 默认：需要关注的 —— 未判断的 + 已批准但未导入的
      filtered = entries.filter(
        (e) => e.relevant === null || (e.approved === true && !e.imported_at)
      );
    }
    json({
      count: filtered.length,
      total: entries.length,
      candidates_path: candidatesPath,
      entries: filtered,
    });
    return;
  }

  if (sub === "apply") {
    // 安全门：apply 默认是 preview（与 --dry-run 等价），必须显式传 --yes 才真正执行。
    // Agent 的流程是："跑一次不带 --yes 拿预览 → 给用户看 → 用户明确同意 → 再带 --yes"。
    // 这样即便 Agent 忽略了 SKILL 规则，也不会在用户没批准前动飞书数据。
    const isDryRun = "dry-run" in flags || !("yes" in flags);
    const explicitDryRun = "dry-run" in flags;
    if (!explicitDryRun && isDryRun) {
      process.stderr.write(
        "[fw] apply 默认为预览模式。确认清单后，加 --yes 执行真正导入：ai-wiki import apply --yes\n"
      );
    }
    if (!isDryRun && !isWriteEnabled()) {
      console.error(
        "当前为学习模式（只读），不能执行 import apply。\n" +
        "如需切换到贡献模式，运行：ai-wiki mode write\n" +
        "（如仅想预演，可加 --dry-run）"
      );
      process.exit(1);
    }
    const destinationNodeToken = importCfg.destination_node_token;
    if (!destinationNodeToken) {
      console.error("错误: 配置缺少 import.destination_node_token");
      process.exit(1);
    }
    const spaceId = cfg.space_id;
    if (!spaceId) {
      console.error("错误: 配置缺少 space_id");
      process.exit(1);
    }
    const summary = imp.applyImport({
      candidatesPath,
      destinationNodeToken,
      spaceId,
      dryRun: isDryRun,
    });
    // 导入成功后同步本地索引缓存与根页面 token 清单，
    // 这样 find/search 能立刻看到新导入的页面（否则要等 60s TTL + 一次 refresh）。
    // 遵循 create/delete 的模式：sync 失败不回滚成功的移动，仅记录告警。
    let sync_error = null;
    if (!isDryRun && summary.succeeded > 0) {
      try {
        const core = require("./core");
        core.refresh();
        core.syncRootPage();
      } catch (err) {
        sync_error = err.message || String(err);
        process.stderr.write(
          `[fw] 警告：import apply 后同步索引/根页面失败（已导入仍有效）：${sync_error}\n`
        );
      }
    }
    json({
      ...summary,
      dry_run: isDryRun,
      candidates_path: candidatesPath,
      sync_error,
    });
    return;
  }

  if (sub === "mark") {
    const token = positional[1];
    if (!token) {
      console.error("用法: ai-wiki import mark <token> --relevant true|false [--reason R]");
      process.exit(1);
    }
    if (!("relevant" in flags)) {
      console.error("错误: 必须传 --relevant true 或 --relevant false");
      process.exit(1);
    }
    const rv = String(flags.relevant).toLowerCase();
    if (rv !== "true" && rv !== "false") {
      console.error("错误: --relevant 必须是 true 或 false");
      process.exit(1);
    }
    const patch = { relevant: rv === "true" };
    if (flags.reason !== undefined) patch.reason = String(flags.reason);
    const { matched, missing } = imp.patchCandidates(candidatesPath, [token], patch);
    if (missing.length > 0) {
      console.error(`错误: 找不到候选: ${missing.join(", ")}`);
      process.exit(1);
    }
    json({ ok: true, marked: matched, relevant: patch.relevant, reason: patch.reason || "" });
    return;
  }

  if (sub === "approve") {
    let tokens = positional.slice(1);
    let affected;
    if ("all-relevant" in flags) {
      affected = imp.approveAllRelevant(candidatesPath);
      json({ ok: true, approved: affected, via: "all-relevant" });
      return;
    }
    if (tokens.length === 0) {
      console.error("用法: ai-wiki import approve <token>... 或 --all-relevant");
      process.exit(1);
    }
    const { matched, missing } = imp.patchCandidates(candidatesPath, tokens, { approved: true });
    if (missing.length > 0) {
      console.error(`警告: 以下 token 不在候选中: ${missing.join(", ")}`);
    }
    json({ ok: true, approved: matched, missing });
    if (missing.length > 0) process.exit(1);
    return;
  }

  if (sub === "reset") {
    const tokens = positional.slice(1);
    const all = "all" in flags;
    if (tokens.length === 0 && !all) {
      console.error("用法: ai-wiki import reset <token>... | --all");
      console.error("  将候选的 relevant/reason/approved 清回 pending（已导入的不动）");
      process.exit(1);
    }
    const affected = imp.resetCandidates(candidatesPath, { tokens, all });
    json({ ok: true, reset: affected, count: affected.length });
    return;
  }

  if (sub === "reject") {
    const tokens = positional.slice(1);
    if (tokens.length === 0) {
      console.error("用法: ai-wiki import reject <token>...");
      process.exit(1);
    }
    const { matched, missing } = imp.patchCandidates(candidatesPath, tokens, {
      approved: false,
      relevant: false,
    });
    if (missing.length > 0) {
      console.error(`警告: 以下 token 不在候选中: ${missing.join(", ")}`);
    }
    json({ ok: true, rejected: matched, missing });
    if (missing.length > 0) process.exit(1);
    return;
  }

  console.error(`未知 import 子命令: ${sub}`);
  process.exit(1);
}

function showHelp() {
  console.log("用法: ai-wiki <command>");
  console.log();
  console.log("读操作:");
  console.log("  find <query>                     模糊搜索页面");
  console.log("  list [--category CAT]            列出页面");
  console.log("  fetch <title> [--fresh]           读取页面正文（markdown）");
  console.log("    --head                         仅返回元数据（JSON）");
  console.log("    --section NAME                 仅返回匹配的 H2 章节");
  console.log("    --excerpt KEYWORD [--window N]  关键词上下文摘录");
  console.log("    --raw                          完整 markdown（默认）");
  console.log("  link <title>                     获取飞书 URL");
  console.log("  grep <pattern>                   本地全文搜索");
  console.log("  search <query> [--all-docs]      飞书 API 搜索（默认只搜 wiki）");
  console.log();
  console.log("写操作:");
  console.log("  create --category CAT --title TITLE [--summary S] [--force] <<< content");
  console.log("  update <title> [--mode append|overwrite] [--force] <<< content");
  console.log("  delete <title> [--reason R] [--force]  软删除（标记已废弃）");
  console.log();
  console.log("导入:");
  console.log("  import scan [folder_token]                扫描云空间文件夹（省略则扫「我的空间」根）");
  console.log("  import list [--pending|--approved|--imported|--all]  查看候选");
  console.log("  import mark <token> --relevant true|false [--reason R]  打相关性判断");
  console.log("  import approve <token>... | --all-relevant  批准导入");
  console.log("  import reject <token>...                  拒绝导入");
  console.log("  import reset <token>... | --all           重置判断字段回 pending");
  console.log("  import apply [--dry-run]                  将 approved 条目搬入 wiki");
  console.log();
  console.log("管理:");
  console.log("  status        缓存状态");
  console.log("  user          当前用户");
  console.log("  sync          手动同步");
  console.log("  refresh       重建索引");
  console.log("  lint [--title T]  健康检查（全量或单页）");
  console.log("  verify-write <title>  验证单页写入质量");
  console.log("  mode          查看/切换模式（read / write）");
  console.log("  feedback      提交反馈");
  console.log("  setup         一键安装和配置（lark-cli + 登录）");
  console.log("  upgrade       检查并升级到最新版本");
  console.log("  help          显示帮助");
}

module.exports = { main };
