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
        console.error("用法: ai-wiki fetch <title> [--fresh]");
        process.exit(1);
      }
      const core = require("./core");
      const page = core.find(query);
      if (!page) {
        console.error(`未找到页面: ${query}`);
        process.exit(1);
      }
      const content = core.fetch(page, { fresh: "fresh" in flags });
      const fetchMeta = core.lastFetchMeta;
      process.stderr.write(
        `[fw] freshness=${fetchMeta.freshness} data_source=${fetchMeta.data_source}\n`
      );
      console.log(content);
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
      core.update(query, content, { mode: flags.mode || "append" });
      json({ ok: true, title: query, mode: flags.mode || "append" });
      break;
    }

    case "delete": {
      if (!query) {
        console.error("用法: ai-wiki delete <title> [--reason REASON]");
        process.exit(1);
      }
      const core = require("./core");
      core.del(query, { reason: flags.reason || "" });
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
      json(core.lint());
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
    try {
      execFileSync(cliPath, ["auth", "login"], { stdio: "inherit" });
      console.log("  ✅ 登录成功");
    } catch {
      console.error("  ❌ 登录失败，请手动执行：lark-cli auth login");
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
      const st2 = core.status();
      console.log(`  ✅ 连接成功！AI Wiki 共 ${st2.pages} 个页面`);
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

function showHelp() {
  console.log("用法: ai-wiki <command>");
  console.log();
  console.log("读操作:");
  console.log("  find <query>                     模糊搜索页面");
  console.log("  list [--category CAT]            列出页面");
  console.log("  fetch <title> [--fresh]           读取页面正文（markdown）");
  console.log("  link <title>                     获取飞书 URL");
  console.log("  grep <pattern>                   本地全文搜索");
  console.log("  search <query> [--all-docs]      飞书 API 搜索（默认只搜 wiki）");
  console.log();
  console.log("写操作:");
  console.log("  create --category CAT --title TITLE [--summary S] <<< content");
  console.log("  update <title> [--mode append|overwrite] <<< content");
  console.log("  delete <title> [--reason R]      软删除（标记已废弃）");
  console.log();
  console.log("管理:");
  console.log("  status        缓存状态");
  console.log("  user          当前用户");
  console.log("  sync          手动同步");
  console.log("  refresh       重建索引");
  console.log("  lint          健康检查");
  console.log("  mode          查看/切换模式（read / write）");
  console.log("  feedback      提交反馈");
  console.log("  setup         一键安装和配置（lark-cli + 登录）");
  console.log("  upgrade       检查并升级到最新版本");
  console.log("  help          显示帮助");
}

module.exports = { main };
