# Claude Code DeepWiki — 原始资料快照

> **来源**: https://deepwiki.com/claude-code-best/claude-code/
> **抓取日期**: 2026-04-08
> **最后索引**: 2026-03-31 (commit dd9cd782)
> **性质**: 逆向工程重建的 Claude Code 代码库自动生成文档（57 页）
> **抓取页面**: 1-overview, 6-query-engine, 16-permission-system, 17-agent-and-swarm-system, 19-settings-configuration, 21-api-layer, 22-context-management, 23-memory-system, 24-hooks-system

---

## 1. Overview

Claude Code is "a high-level CLI agent and REPL designed for terminal-based software engineering. It integrates LLM capabilities (via Anthropic, Bedrock, or Vertex) with local system access through a robust tool and permission system."

### Key Architecture

- Built as a Bun monorepo using workspaces
- Custom fork of Ink library for React-based terminal rendering
- Runtime: Bun (primary), all imports and builds use Bun APIs
- Monorepo layout: `packages/` for internal logic, `@ant/` for Anthropic-specific stubs
- Polyfill system using `feature()` flag and `globalThis.MACRO` injection

### High-level System Flow

```
Natural Language Space → CLI entrypoint → QueryEngine → LLM API interaction → Tool dispatch → execution
```

### Key Capabilities

| Category | Tools | Purpose |
|----------|-------|---------|
| Filesystem | FileReadTool, FileWriteTool, FileEditTool | File operations and diffs |
| Shell | BashTool, PowerShellTool | Command execution with sandboxing |
| Orchestration | AgentTool, Subagent | Multi-agent spawning |
| UI/UX | src/ink/, REPL.tsx | Terminal interface |
| Permissions | PermissionMode, yoloClassifier | Multi-tier approval |

### Environment Requirements

- Bun runtime (primary)
- Valid API Key (Anthropic, AWS Bedrock, Google Vertex AI, or Azure Foundry)
- OS: Cross-platform, some NAPI modules macOS-specific

### CLI Flags

- `-p, --pipe` - Pipe mode (stdin input, single response exit)
- `--debug-to-stderr` - Redirect debug logs to stderr
- `--version` - Report version via MACRO system

### MACRO and Feature Polyfill System

The codebase uses runtime polyfills in `src/entrypoints/cli.tsx`:
- `feature()` function gates experimental capabilities (returns false for unimplemented features like COORDINATOR_MODE, KAIROS)
- `globalThis.MACRO` simulates build-time constants for versioning and metadata
- BUILD_TARGET and INTERFACE_TYPE injected at startup

```javascript
globalThis.MACRO = {
  VERSION: "0.1.0",
  BUILD_TARGET: "bun",
  INTERFACE_TYPE: "terminal"
}
```

### Monorepo Structure

**Workspace Layout:**
- `packages/@ant/*` - Internal scoped packages (Computer Use MCP, Chrome MCP, etc.)
- `packages/*-napi` - Native modules (color-diff, image-processor, audio-capture, modifiers, url-handler)
- `src/` - Main TypeScript/React application
- `scripts/` - Maintenance utilities

**Internal Packages (@ant scope):**
- `@ant/computer-use-mcp` - MCP server for OS interaction
- `@ant/computer-use-input` - Low-level mouse/keyboard APIs
- `@ant/claude-for-chrome-mcp` - Browser automation
- `@ant/computer-use-swift` - macOS-specific components

**Native Packages (NAPI):**
- `color-diff-napi` - Terminal diff rendering (depends on highlight.js)
- `image-processor-napi` - Screenshot processing
- `audio-capture-napi` - Audio stream capture
- `modifiers-napi` - macOS modifier key tracking
- `url-handler-napi` - OS-level URL scheme handling

**Source Directory Organization:**
- `src/entrypoints/` - CLI and SDK entry points
- `src/commands/` - Slash command implementations
- `src/tools/` - Agent tool definitions
- `src/services/` - External API integrations
- `src/state/` - React context and state management
- `src/ink/` - Custom Ink rendering fork

### Runtime Component Interconnection

```
src/entrypoints/cli.tsx → src/main.tsx → src/screens/REPL.tsx
                                              ↓
                        src/QueryEngine.ts ← → src/services/api/claude.ts
                             ↓
                        src/Tool.ts → src/tools.ts
                             ↓
                    [Filesystem, Shell, MCP]
```

---

## 6. Query Engine and Conversation Loop

### QueryEngine Overview

"The QueryEngine class, defined in src/QueryEngine.ts, is designed to be a standalone controller for a single conversation session."

**Maintained state:**
- Message history
- Usage tracking (token count, cost)
- File cache (FileStateCache)
- Permission integration

### Conversation Loop (submitMessage lifecycle)

1. Input processing via `processUserInput`
2. Context assembly via `fetchSystemPromptParts` and `loadMemoryPrompt`
3. API call to Claude via `query()`
4. Tool dispatch with permission validation
5. Compaction triggers when history exceeds limits

### Tool Use Context

Tools receive context including:
- `abortController` for cancellation
- `handleElicitation` for MCP auth/parameters
- `setAppState` for global state updates

### Session Persistence

Interacts with `sessionStorage.ts` to record transcripts and flush state to disk, enabling session resume via `/resume`.

### Compaction Strategies

- Micro-compaction: Remove redundant outputs
- Snip compaction: Truncate old history with summary
- Session memory: Move facts into CLAUDE.md via `loadMemoryPrompt`

---

## 16. Permission System

### Permission Modes

The `PermissionMode` enum defines four operational states:

1. **default**: Prompts users for actions not on pre-approved allowlists
2. **acceptEdits**: Auto-approves file-writing commands but may prompt for arbitrary bash
3. **bypassPermissions**: Executes all commands without prompting (gated by `isBypassPermissionsModeAvailable`)
4. **plan**: Simulates execution or validates commands for planning purposes

### ToolPermissionContext Structure

- **mode**: Current `PermissionMode` determining approval behavior
- **alwaysAllowRules**: Maps enabling automatic approval for safe patterns
- **alwaysDenyRules**: Maps blocking dangerous operations
- **alwaysAskRules**: Patterns requiring explicit user confirmation
- **additionalWorkingDirectory**: Filesystem boundaries for path validation

### The YOLO Classifier

- Operates within permission validation gates before user prompts
- Consumes `cachedClaudeMdContent` to prevent circular dependencies between project instructions and classifier logic
- Integrated into the permission check pipeline alongside explicit allow/deny rules
- Determines confidence thresholds for auto-approving tool execution

### Trust Model Integration

1. **Prompt Integration**: System prompts incorporate permission modes, influencing model behavior. Models receive visibility into current trust levels.
2. **State Flow**: `AppState` and bootstrap `State` track permission decisions. `sessionPersistenceEnabled` allows session recovery with preserved permission contexts.
3. **Error Handling**: `DenialTrackingState` records rejected permissions, preventing redundant user prompts for identical denied actions.
4. **File Context Cache**: `FileStateCache` and `cachedClaudeMdContent` provide models with project context necessary for permission classification decisions.
5. **Subagent Isolation**: When spawning agents via `AgentTool`, permission contexts may be reset or inherited based on task delegation type, maintaining trust boundaries across agent boundaries.

### Permission Execution Flow

1. **Input Validation** via `validateInput()` against Zod schemas
2. **Permission Check** evaluating `ToolPermissionContext` rules
3. **Denial Tracking** consultation for previous rejections
4. **User Prompt** (if needed) via `PermissionDialog` in Ink UI
5. **Execution** via `call()` method
6. **State Update** propagating results through `setAppState`

---

## 17. Agent and Swarm System

### Agent Spawning Mechanisms

Claude Code spawns sub-agents through the `AgentTool`, which creates new session contexts with isolated execution environments. When invoked, the system generates a unique `AgentId` with prefix `a` (local agents), `r` (remote), or `t` (swarm teammates). Each spawned agent receives:

- A fresh `SessionId` generated via `randomUUID()`
- A `parentSessionId` linking back to the originating session
- A unique color assignment via `agentColorManager` for terminal UI distinction
- Independent message history and state tracking

The spawning occurs through functions like `runAgent`, `forkSubagent`, or `resumeAgent`. Forking is notable because it "allows an agent to clone the current state to explore a hypothesis without polluting the main history."

### Context Flow Between Parent and Child Agents

Context flows bidirectionally between parent and child agents through the `ToolUseContext` and `AppState`. The parent agent maintains:

- `lastAPIRequest` and `lastAPIRequestMessages` capturing the exact message set sent to the API
- `modelUsage` tracking per-model token consumption
- `sessionCronTasks` for scheduled operations created by child agents

Child agents access parent context via `readFileState` (optimized file cache) and receive `ToolUseContext` providing:

- `mcpClients`: Active MCP server connections inherited from parent
- `abortController`: Signals for cancellation propagation
- `setAppStateForTasks`: Root store access allowing children to update shared infrastructure

The system tracks agent lineage through `parentSessionId`, enabling correlation of background tasks with originating sessions.

### Subagent Prompt Construction

Subagent prompts are constructed by the `QueryEngine` which assembles:

1. **System Prompts**: Via `fetchSystemPromptParts`
2. **Memory Context**: Via `loadMemoryPrompt` (reading `CLAUDE.md`)
3. **Environment Metadata**: Including `projectRoot`, `cwd`, and current model information
4. **Compacted History**: Using strategies like `snipReplay` to prevent context overflow

The `normalizeMessage` function ensures subagent messages conform to SDK format. When a subagent is spawned, it receives a blank message history but inherits access to the project's cached `claudeMdContent`, preventing circular dependencies between the `yoloClassifier` (permission system) and file reading.

### Isolation Mechanisms

Isolation between agents operates at multiple levels:

**Filesystem Isolation**: `EnterWorktreeTool` uses git worktrees, allowing simultaneous work on "separate branches without polluting the main workspace."

**State Isolation**: Each agent maintains independent:
- Message arrays in the `QueryEngine`
- `FileStateCache` tracking file versions separately
- `PermissionMode` settings (agents can be spawned in different modes)
- Cost tracking via individual `modelUsage` maps

**Permission Context Isolation**: Each agent receives a `ToolPermissionContext` with:
- Separate `alwaysAllowRules` and `alwaysDenyRules`
- Independent `additionalWorkingDirectory` constraints
- Mode-specific authorization via `isBypassPermissionsModeAvailable`

**Execution Isolation**: Background tasks (`TaskStateBase`) track spawned subagents via `sessionCreatedTeams`, ensuring cleanup during `gracefulShutdown` "to prevent disk clutter."

The system uses `abortController` to propagate cancellation signals while preventing uncontrolled cascade termination. Task status transitions through defined states (`pending` → `running` → terminal), with `isTerminalTaskStatus` determining cleanup eligibility.

---

## 19. Settings, Configuration, and Plugins

### Configuration Hierarchy

1. **Bootstrap State** (`src/bootstrap/state.ts`): "Low-level primitives like `sessionId`, `cwd`, and session persistence settings" establish process-wide defaults before any application logic executes.
2. **AppState** (`src/state/AppState.tsx`): "High-level UI and session state (messages, active tools, permissions)" manages runtime context reactively through React Context.
3. **Config Utilities** (`src/utils/config.ts`): Handles user-specific configuration files and environment variable overrides.

### CLAUDE.md Memory System

"The system includes flags for `scheduledTasksEnabled` and `sessionCronTasks`," which persist across executions. The system "tracks `cachedClaudeMdContent`" to provide "a stable snapshot of project instructions for the agent's internal classifiers."

The `loadMemoryPrompt` function in QueryEngine "gathers system prompts via `fetchSystemPromptParts`, memory (from `CLAUDE.md`) via `loadMemoryPrompt`, and environment metadata," making project-specific instructions central to every conversation turn.

### Plugin System Architecture

1. **MCP Integration**: "The system uses a centralized registry in `src/tools.ts` to manage all available capabilities." MCP servers act as dynamic tool providers, with "support for deferred loading and official MCP registry integration."
2. **Tool Registry Pattern**: Tools are "registered in the global tool registry" through a `buildTool` factory that enforces "type safety between the Zod schema and the `call` arguments."
3. **Workspace Packages**: "Internal packages under the `@ant` namespace provide modularized capabilities."

### Context Management and Settings Impact

- **Compaction Strategies**: "To prevent the context window from overflowing, the `QueryEngine` implements several compaction strategies." Including micro-compaction, snip compaction, and "moving long-term facts into `CLAUDE.md`."
- **File State Caching**: Tools interact with "a `FileStateCache` to track filesystem changes across turns," reducing redundant file reads that would consume token budget.
- **Permission Modes**: Configuration through `ToolPermissionContext` determines whether operations auto-execute, require approval, or are blocked.

### Key Configuration Touch Points

1. **Feature Flags**: "`feature()` function acts as a global toggle for experimental or secondary capabilities."
2. **MACRO Injection**: "The `MACRO` object simulates constants typically injected by `bun build`."
3. **Session Persistence**: "Sessions can be resumed via `/resume` or recovered after a crash."

---

## 21. API Layer and Model Providers

### System Prompt Assembly

The system initializes context through `fetchSystemPromptParts` in the QueryEngine, which gathers multiple prompt fragments before sending to Claude:

1. **Core Instructions**: Base system prompt defining Claude Code's role and capabilities
2. **Memory Integration**: Content loaded via `loadMemoryPrompt` from project-specific `CLAUDE.md` files
3. **Environment Metadata**: Project root, session ID, and filesystem context
4. **Tool Definitions**: Schema information for all available tools

Sources: src/QueryEngine.ts:34-36, src/QueryEngine.ts:74-74

### Message Formatting and Normalization

Messages are normalized using `normalizeMessage` to ensure conformance with SDK format requirements before API submission:
- Converting user text into properly structured message blocks
- Handling "orphaned permissions" — prior session authorizations requiring re-validation
- Maintaining consistent message history structure across API calls

Sources: src/utils/queryHelpers.ts:109-109, src/utils/queryHelpers.ts:107-107

### API Request Construction

The `query()` function constructs API requests by combining:
- Assembled system prompts
- Message history (post-compaction)
- Active tool registry with input schemas
- Usage tracking parameters

The system captures the exact post-compaction message set in `lastAPIRequestMessages` for debugging and session recovery.

Sources: src/QueryEngine.ts:36-36, src/bootstrap/state.ts:113-118

### API Provider Integration

| Provider | Configuration | Implementation |
|:---|:---|:---|
| **Anthropic** | Direct API key | Primary endpoint |
| **AWS Bedrock** | AWS credentials | Regional deployment |
| **Google Vertex AI** | GCP authentication | Managed service |
| **Azure Foundry** | Azure credentials | Enterprise option |

### Error Handling and Retries

API errors are categorized using `categorizeRetryableAPIError`, which classifies failures as transient (retryable) or terminal. The engine implements retry logic for transient failures while surfacing errors to the REPL via `setSDKStatus` callback.

---

## 22. Context Management and Compaction

### Message History and State Tracking

The QueryEngine maintains internal conversation state including:
- Message history as an array of Message objects
- Cumulative token usage and session costs
- FileStateCache for tracking filesystem changes across turns
- Permission integration via canUseTool hooks

The engine tracks `lastAPIRequest` and `lastAPIRequestMessages` to capture the exact post-compaction message set sent to the API, enabling accurate debugging and cost attribution.

### File State Management

The `FileStateCache` in ToolUseContext optimizes repeated file reads by caching versions and tracking changes. This prevents stale reads when the model accesses the same file multiple times within a single conversation turn.

The system maintains `cachedClaudeMdContent` as a stable snapshot of project instructions, breaking circular dependencies between the permission classifier, CLAUDE.md reading, and the permission system itself.

### Multi-Tier Compaction

**Micro-Compaction**: Removes redundant tool outputs or intermediate reasoning steps from recent history.

**Snip Compaction**: Truncates older history sections and replaces them with summary "snip" messages, preserving only essential context while freeing tokens.

**Session Memory**: Moves long-term facts into CLAUDE.md via the `loadMemoryPrompt` mechanism, creating a persistent knowledge base across sessions.

### Compaction Trigger Conditions

The QueryEngine checks context limits after each turn. When triggered, it invokes `snipReplay` or internal compaction logic configured in QueryEngineConfig. The system uses `maxBudgetUsd` limits to enforce cost-based compaction in addition to token-based thresholds.

### Context Assembly

Before each API call, the engine gathers:
- Base system prompts via `fetchSystemPromptParts`
- Memory context via `loadMemoryPrompt`
- Environment metadata and tool definitions
- File history and recent modifications

### Post-Compaction Message Set

The `lastAPIRequestMessages` captures the exact message array after all compaction has occurred. This enables precise cost tracking and allows the system to understand what the model actually received versus what the user originally provided.

### Token Budget Enforcement

The system enforces `maxBudgetUsd` limits by checking accumulated cost after each turn. When limits are approached, compaction is automatically triggered before the next API call.

### Selective Context Inclusion

The FileEditTool uses structured diffs to minimize token consumption during edits. Rather than including entire file contents, it sends only the relevant context around proposed changes.

---

## 23. Memory System

### CLAUDE.md File Structure

The memory system centers on a `CLAUDE.md` file that serves as persistent project memory. This file is loaded via `loadMemoryPrompt()` during context assembly in the QueryEngine (src/QueryEngine.ts:34-36).

**Key characteristics:**
- Stores long-term facts about the project
- Prevents circular dependencies with permission classifiers
- Content is cached in `cachedClaudeMdContent` to provide stable snapshots (src/bootstrap/state.ts:121-123)
- Acts as a bridge between session memory and the yolo classifier

### Global State Tracking

The bootstrap state in `src/bootstrap/state.ts` maintains telemetry and session metadata:

**Session Identity:**
- `sessionId`: Uniquely identifies current execution (src/bootstrap/state.ts:100)
- `parentSessionId`: Tracks lineage for subagents (src/bootstrap/state.ts:102)
- `agentColorMap`: Visual distinction for multiple agents

**Execution Tracking:**
- `lastAPIRequest` and `lastAPIRequestMessages`: Captures exact post-compaction message sets sent to Claude (src/bootstrap/state.ts:113-118)
- `modelUsage`: Per-model token accumulation (src/bootstrap/state.ts:67-69)
- `totalCostUSD`: Running budget tracking (src/bootstrap/state.ts:51)

### Compaction Strategies

**Micro-Compaction**: Removes redundant tool outputs and intermediate thoughts via `src/services/compact/`

**Snip Compaction**: Truncates old history and replaces with summary via `snipReplay` in QueryEngineConfig (src/QueryEngine.ts:171-175)

**Session Memory**: Moves long-term facts into CLAUDE.md via `loadMemoryPrompt()` (src/QueryEngine.ts:34)

### State Management Layers

**Bootstrap State (Process-Wide):**
- Project root and working directory (src/bootstrap/state.ts:46-50)
- OpenTelemetry providers for telemetry (src/bootstrap/state.ts:90-96)
- Filesystem state caches and file history tracking

**AppState (React-Driven):**
High-level UI reactivity via `AppStateProvider` in `src/state/AppState.tsx`. Uses signal-based fine-grained updates (src/bootstrap/src/utils/signal.ts:2).

State Flow: Bootstrap State → AppStateStore → useAppState() hooks → REPL/UI components

### Scheduled Tasks and Durability

**Durable Tasks**: Written to `.claude/scheduled_tasks.json` when `scheduledTasksEnabled` is true (src/bootstrap/state.ts:134-137)

**Session Tasks**: Stored in `sessionCronTasks`, cleared on exit (src/bootstrap/state.ts:138-143)

**Cleanup Protocol**: System tracks `sessionCreatedTeams` to remove subagent-created teams during graceful shutdown (src/bootstrap/state.ts:144-149)

### Context Assembly Process

The QueryEngine assembles context via:
1. **System Prompts**: Fetched via `fetchSystemPromptParts()`
2. **Memory Loading**: Retrieved through `loadMemoryPrompt()` from CLAUDE.md
3. **Environment Metadata**: Current session state and permissions
4. **Message History**: Full conversation transcript with compaction applied

### Permission System Integration

The memory system prevents circular dependencies with permission validation through `cachedClaudeMdContent`. This cache breaks the dependency chain: yoloClassifier → CLAUDE.md reading → permission system (src/bootstrap/state.ts:121-123).

The system provides "orphaned permission" handling — authorizations from previous sessions that were interrupted can be recovered (src/utils/queryHelpers.ts:107).

### Session Persistence

The `QueryEngine` interacts with `src/utils/sessionStorage.ts` to ensure transcripts are recorded and state flushed to disk (src/utils/sessionStorage.ts:77-79). Sessions can be resumed via `/resume` command or recovered after crash.

---

## 24. Hooks System

### Hook Injection Points

The system implements hooks as integration mechanisms throughout the conversation lifecycle. The documentation references `HookEvent` and `ModelUsage` types defined in `src/entrypoints/agentSdkTypes.ts`.

Hooks operate at two primary levels:

1. **Lifecycle Hooks**: The system tracks agent state transitions through designated lifecycle events, allowing external code to observe or react to phase changes like task spawning, completion, or errors.
2. **Permission Hooks**: The `useCanUseTool` mechanism validates whether specific tool invocations should proceed, integrating permission checks into the execution flow.

### Event System Architecture

The conversation loop operates as a turn-based sequence:
- User input processing via `processUserInput`
- Context assembly including system prompts via `fetchSystemPromptParts`, memory via `loadMemoryPrompt`
- API calls to Claude
- Tool dispatch with permission validation
- Result rendering

Hooks can intercept at the tool dispatch layer through `ToolPermissionContext`, which contains `alwaysAllowRules`, `alwaysDenyRules`, and mode settings.

### Context Modification Mechanisms

Tools receive a `ToolUseContext` providing functions like `setAppState` and `setToolJSX`, enabling tools to update the UI/application state and trigger reactive re-renders in the Terminal UI.

The broader state flows through `AppStateStore` (signal-based reactivity), allowing hooks to observe or modify conversation metadata, active tools, and permissions mid-execution.
