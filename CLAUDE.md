# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

AI Wiki — an AI Agent-maintained collaborative knowledge base focused on AI Agents, hosted on Feishu/Lark wiki. The Agent reads sources, extracts knowledge, writes to the wiki via `ai-wiki` CLI, and maintains cross-references.

## Commands

```bash
# Run all tests (Node.js built-in test runner, no dependencies needed)
node --test tests/*.test.js

# Run a single test file
node --test tests/core.test.js

# Run the CLI directly from source
node src/bin/cli.js <command>

# Package for distribution
cd src && npm pack
```

There is no build step, no linter, and no transpilation. The project is plain CommonJS JavaScript targeting Node.js 16+.

## Architecture

```
src/
├── bin/cli.js          # Entry point: requires commands.js, calls main()
├── lib/
│   ├── commands.js     # CLI router: parseArgs() + switch/case for all commands
│   ├── core.js         # Index building, cache, CRUD, wikilinks, lint, QA logging
│   ├── lark.js         # lark-cli subprocess wrapper (execFileSync)
│   ├── lock.js         # Distributed FIFO write lock via Feishu Queue page
│   └── search.js       # Local grep + Feishu API search
├── scripts/
│   └── postinstall.js  # npm postinstall: copies skills to ~/.agents, ~/.claude, ~/.codex
├── skills/
│   ├── SKILL.md        # Agent skill manifest (YAML frontmatter + full operating manual)
│   ├── default-config.json
│   ├── agents/         # Platform-specific agent configs (claude.yaml, openai.yaml)
│   ├── references/     # architecture.md
│   └── templates/      # Page templates (source, raw-material, entity-topic)
└── package.json
```

**Key data flow:** All Feishu API access goes through `lark.js` → `lark-cli` subprocess. No direct HTTP calls. `core.js` manages a lazy cache (`.cache/` relative to cwd) with 60s TTL index and on-demand page fetching.

**Index building:** On first run, `ensureCache()` spawns `scripts/build-index.js` as a detached background process. Commands return empty/graceful results while building. `ai-wiki status` reports `{"cache":"building"}`. Explicit `ai-wiki refresh` still builds synchronously.

**Cloud token manifest:** The wiki root page embeds `<!-- wiki-tokens:tok1,tok2,... -->`. When local index isn't ready, `search` fetches this single page to get the token set for wiki-only filtering — so search works immediately during index build.

**Write path:** `commands.js` → `core.create/update/del` → `lock.withLock()` → `lark.uploadPage()`. The lock is a FIFO queue stored as a Feishu wiki page — poll every 15s, auto-expire after 5 min. Every create/delete also syncs the root page (which updates the token manifest).

**Postinstall:** Copies skill files to `~/.agents/skills/ai-wiki/` (canonical), creates symlinks at `~/.claude/skills/ai-wiki` and `~/.codex/skills/ai-wiki`.

## Agent Skill

The full Agent operating manual is in [src/skills/SKILL.md](src/skills/SKILL.md). Architecture details are in [src/skills/references/architecture.md](src/skills/references/architecture.md). Page templates are in `src/skills/templates/`.

## Conventions

- All wiki page content is written in **Chinese**. Proper nouns keep original English: `中文名（English Name）`.
- Wiki links use `[[页面名]]` syntax — resolved to `<mention-doc>` tags on write.
- Write operations are gated by mode: `ai-wiki mode write` to enable, `ai-wiki mode read` to disable.
- `.cache/` is runtime-only (cwd-relative) — never commit it.
- All operations go through `ai-wiki` CLI — never call `lark-cli` directly or modify `.cache/` manually.
- `原始资料/*` pages are immutable archives — never modify after creation.
- Every new API/CLI feature must be documented in SKILL.md, CHANGELOG.md, and package.json.
