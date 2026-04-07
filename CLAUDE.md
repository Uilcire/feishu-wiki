# AI Wiki — Schema Document

## What This Is

A personal knowledge base focused on **AI agents** — architectures, frameworks, techniques, papers, tools, and the evolving ecosystem. Maintained by an LLM (Claude), browsed in Obsidian.

You (Claude) are the wiki maintainer. You read sources, extract knowledge, write and update wiki pages, maintain cross-references, and keep everything consistent. The user curates sources, asks questions, and directs exploration. You do all the bookkeeping.

## Domain

Technical learning in AI agents. This includes:
- Agent architectures (ReAct, tool-use, planning, reflection, multi-agent)
- Frameworks and tools (LangChain, CrewAI, AutoGen, Claude Code, OpenAI Agents SDK, etc.)
- Foundation model capabilities relevant to agents (function calling, structured output, reasoning)
- Prompt engineering techniques for agent systems
- Evaluation and benchmarking of agent systems
- Production patterns (error recovery, human-in-the-loop, guardrails, observability)
- Key people, labs, and papers in the field

## Vault Structure

```
ai-wiki/
├── CLAUDE.md            ← this file (schema)
├── raw/                 ← immutable source documents
│   ├── articles/
│   ├── papers/
│   ├── books/
│   └── assets/          ← downloaded images
├── wiki/                ← LLM-generated, LLM-maintained
│   ├── index.md         ← navigable catalog of all wiki pages
│   ├── entities/        ← people, orgs, frameworks, tools
│   ├── topics/          ← concept and subject summaries
│   ├── sources/         ← per-source summary pages
│   └── synthesis/       ← cross-source analyses, comparisons, theses
├── log.md               ← chronological activity log
└── .git/
```

### Layer Rules

- **raw/**: Immutable. Never modify source documents. Read only.
- **wiki/**: LLM-owned. Claude creates, updates, and maintains all files here. User reads and browses.
- **CLAUDE.md**: Co-evolved. User and Claude update this together as conventions emerge.

## Page Conventions

### Source Pages (`wiki/sources/`)

One page per ingested source. Filename: kebab-case of title.

```markdown
---
source_type: article | paper | book | video | talk | gist
author: [name]
date: [publication date]
url: [if applicable]
ingested: [date]
tags: [topic tags]
---

# [Source Title]

## Key Takeaways
- [3-7 bullet points — the essential ideas]

## Summary
[2-4 paragraphs capturing the source's argument and contribution]

## Notable Claims
- [Specific claims worth tracking — may confirm or contradict other sources]

## Entities Mentioned
- [[Entity Name]] — [brief context of how they appear in this source]

## Topics
- [[Topic Name]] — [how this source contributes to the topic]

## Raw Source
`raw/[path to source file]`
```

### Entity Pages (`wiki/entities/`)

One page per person, organization, framework, tool, or model. Filename: kebab-case of name.

```markdown
---
type: person | org | framework | tool | model | benchmark
aliases: [alternate names]
updated: [date]
source_count: [number of sources mentioning this entity]
---

# [Entity Name]

## Overview
[2-3 sentences — what this entity is and why it matters in the AI agent space]

## Key Facts
- [Factual claims with source attribution: "claim" — [[source page]]]

## Connections
- [[Related Entity]] — [relationship description]

## Sources
- [[Source Page 1]]
- [[Source Page 2]]
```

### Topic Pages (`wiki/topics/`)

One page per concept, technique, or subject area. These are the wiki's analytical backbone.

```markdown
---
updated: [date]
source_count: [number of sources touching this topic]
maturity: stub | developing | solid | comprehensive
---

# [Topic Name]

## Overview
[What this concept is, why it matters, current state of understanding]

## Key Ideas
[The core ideas, synthesized across sources — not just listing what each source says]

## Open Questions
[What's unresolved, debated, or unclear across sources]

## Contradictions
[Where sources disagree — cite both sides]

## Related Topics
- [[Topic]] — [relationship]

## Sources
- [[Source Page]] — [what this source contributes to the topic]
```

### Synthesis Pages (`wiki/synthesis/`)

Cross-source analyses created during queries or lint passes. Comparisons, timelines, evolving theses.

```markdown
---
type: comparison | timeline | thesis | analysis
created: [date]
updated: [date]
sources_used: [list]
---

# [Title]

[Content — format varies by type]
```

## Index (`wiki/index.md`)

The master catalog. Organized by category. Updated on every ingest.

```markdown
# Index

## Sources
- [[source-page]] — one-line summary (author, date)

## Entities
- [[entity-page]] — type, one-line description

## Topics
- [[topic-page]] — maturity level, one-line description

## Synthesis
- [[synthesis-page]] — type, one-line description
```

## Log (`log.md`)

Append-only. One entry per operation. Parseable with grep.

```markdown
## [YYYY-MM-DD] ingest | Source Title
Processed [source]. Created [N] new pages, updated [M] existing pages.
Pages created: [[page1]], [[page2]]
Pages updated: [[page3]], [[page4]]

## [YYYY-MM-DD] query | Question asked
Question: [the question]
Answer filed as: [[synthesis/page-name]] (or "answered in chat, not filed")

## [YYYY-MM-DD] lint | Health check
Findings: [summary of what was found and fixed]
```

## Operations

### Ingest

When the user provides a new source:

1. **Read** the source document completely
2. **Discuss** key takeaways with the user — what's interesting, what to emphasize
3. **Create** a source summary page in `wiki/sources/`
4. **Create or update** entity pages for people, tools, frameworks mentioned
5. **Create or update** topic pages for concepts covered
6. **Update** `wiki/index.md` with new entries
7. **Append** to `log.md`
8. **Commit** all changes with message: `ingest: [source title]`

A single source typically touches 5-15 wiki pages. Take your time — thoroughness matters more than speed.

### Query

When the user asks a question:

1. **Read** `wiki/index.md` to find relevant pages
2. **Read** the relevant wiki pages
3. **Synthesize** an answer with citations to wiki pages (which cite sources)
4. **Offer** to file the answer as a synthesis page if it's worth keeping
5. If filed, **update** index and **append** to log

### Lint

When the user asks for a health check (or periodically suggest it):

1. **Check** for contradictions between pages
2. **Check** for stale claims that newer sources have superseded
3. **Check** for orphan pages (no inbound links)
4. **Check** for important concepts mentioned but lacking their own page
5. **Check** for missing cross-references
6. **Suggest** new questions to investigate or sources to look for
7. **Fix** issues found, **append** to log

## Conventions

- Use `[[wikilinks]]` for all internal references (Obsidian resolves these)
- Tags in frontmatter use kebab-case: `multi-agent-systems`, `tool-use`
- Dates are ISO 8601: `2026-04-07`
- When uncertain about a claim, mark it: `[unverified]` or `[contradicted by [[source]]]`
- Prefer updating existing pages over creating new ones — consolidation over proliferation
- Every factual claim should trace back to a source. No unsourced claims in the wiki.

## What NOT to Do

- Never modify files in `raw/`
- Never make claims without source attribution
- Never delete wiki pages without user approval — mark as `[deprecated]` instead
- Never create pages for entities/topics with only one mention — wait for a second source to confirm relevance
- Don't over-split topics. Prefer one rich page over three thin stubs.
