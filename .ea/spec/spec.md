# cc_hapi — claude-internal Support for Open-Source HAPI

## Overview

Fork of [tiann/hapi](https://github.com/tiann/hapi) with `claude-internal` (Tencent internal Claude Code) as a first-class agent, plus remote web access via SSH tunnel.

- **Repo**: `packages/hapi` (branch `eason`, upstream `tiann/hapi:main`)
- **Hub URL**: http://localhost:3006 / https://hapi.easonsi.site
- **Version**: 0.16.4 (synced with upstream 2026-03-25)

See also: [tencent-hapi.md](tencent-hapi.md) — Tencent internal fork (`hapi-internal`, port 3007, isolated)

---

## Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Web Browser (localhost:3006 / hapi.easonsi.site)            │
│  - Session list, chat UI, permission approval, terminal      │
│  - AgentSelector: claude / claude-internal / codex / ...     │
└────────────────────────┬─────────────────────────────────────┘
                         │ REST + SSE + Socket.IO
┌────────────────────────▼─────────────────────────────────────┐
│  Hub (:3006)                              [cc_hapi_hub]      │
│  - Hono API server + embedded Vite PWA                       │
│  - SQLite persistence (sessions, messages, machines)         │
│  - SSE broadcast to web clients                              │
│  - Socket.IO /cli namespace (CLI ↔ Hub RPC)                  │
│  - Socket.IO /terminal namespace (web terminal)              │
│  - RPC Gateway → Runner (spawn, kill, resume)                │
└────────────────────────┬─────────────────────────────────────┘
                         │ Socket.IO /cli + RPC
┌────────────────────────▼─────────────────────────────────────┐
│  Runner (background daemon)               [cc_hapi_runner]   │
│  - Connects to Hub via Socket.IO, sends machine-alive (20s)  │
│  - Receives spawn-happy-session RPC                          │
│  - spawnHappyCLI() → detached hapi process                   │
│  - Tracks PIDs, handles session lifecycle                    │
└────────────────────────┬─────────────────────────────────────┘
                         │ spawnHappyCLI()
┌────────────────────────▼─────────────────────────────────────┐
│  Claude Code CLI (claude / claude-internal)                   │
│  - Remote mode: --input-format stream-json (stdin/stdout)    │
│  - Local mode: stdio:inherit + JSONL directory-scan          │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow

```
User (Web UI)                Hub                     CLI/Runner
     │                        │                          │
     ├── POST /spawn ────────►│── RPC spawn-session ────►│── spawnHappyCLI()
     │                        │                          │── claude-internal --input-format stream-json
     │                        │◄── machine-alive (20s) ──│
     │◄── SSE events ────────│◄── Socket.IO events ─────│
     ├── POST /messages ─────►│── RPC user-message ─────►│── stdin JSON
     │◄── SSE stream ────────│◄── assistant events ──────│── stdout JSON
     ├── POST /permissions ──►│── RPC approve ──────────►│── tool execution
```

### Package Structure

| Package | Description |
|---------|-------------|
| `cli/` | Main CLI — wraps AI agents, connects to Hub, manages Runner |
| `hub/` | Central server — REST API, Socket.IO, SSE, SQLite |
| `web/` | React PWA — session list, chat, permissions, terminal |
| `shared/` | Shared types, Zod schemas, utilities (`@hapi/protocol`) |

### Key Source Directories (CLI)

```
cli/src/
├── agent/         # Multi-agent framework (abstract base classes)
├── claude/        # Claude Code integration
│   ├── sdk/       # SDK wrapper (query, utils, metadata)
│   ├── utils/     # sessionScanner, path, systemPrompt
│   ├── claudeRemote.ts      # Remote mode (stream-json)
│   ├── claudeLocalLauncher.ts # Local mode launcher
│   ├── loop.ts    # Main session loop
│   ├── runClaude.ts          # Entry point for claude sessions
│   └── session.ts # Session state class
├── runner/        # Background daemon (spawn, track, cleanup)
├── commands/      # CLI command definitions
└── modules/       # Utilities (hooks, watcher, ripgrep)
```

---

## Custom Modifications (eason branch)

6 commits on top of upstream/main:

### 1. claude-internal Flavor Support

**Core idea**: A `flavor` string (`'claude-internal'` / `'claude'` / `undefined`) threads through the entire stack, controlling CLI discovery, config dir, session scanning, and spawn behavior.

| Layer | File | What Changes |
|-------|------|-------------|
| CLI discovery | `cli/src/claude/sdk/utils.ts` | `getDefaultClaudeCodePath(flavor)` — flavor-aware binary search |
| Config dir | `cli/src/claude/utils/path.ts` | `setCliConfigDir()` — `~/.claude-internal/` vs `~/.claude/` |
| Session scan | `cli/src/claude/utils/sessionScanner.ts` | `directory-scan` mode (3s polling) for claude-internal |
| Remote mode | `cli/src/claude/claudeRemote.ts` | Skip `--settings` flag for claude-internal |
| Local mode | `cli/src/claude/claudeLocalLauncher.ts` | Flavor → discoveryMode selection |
| Session | `cli/src/claude/session.ts` | `flavor?: string` property |
| Loop | `cli/src/claude/loop.ts` | Thread flavor to Session constructor |
| Entry | `cli/src/claude/runClaude.ts` | `flavorOverride` in StartOptions |
| Command | `cli/src/commands/claude.ts` | `hapi claude-internal` subcommand |
| SDK query | `cli/src/claude/sdk/query.ts` | `isCommandOnly` includes `'claude-internal'` |

### 2. Web UI Agent Selection

| Layer | File | What Changes |
|-------|------|-------------|
| Types | `web/src/components/NewSession/types.ts` | `AgentType` includes `'claude-internal'` |
| UI | `web/src/components/NewSession/AgentSelector.tsx` | Radio button for claude-internal |
| Spawn API | `web/src/hooks/mutations/useSpawnSession.ts` | Agent param in spawn input |
| Flavor utils | `web/src/lib/agentFlavorUtils.ts` | `isClaudeFlavor('claude-internal')` → true |
| Hub routes | `hub/src/web/routes/machines.ts` | Zod schema accepts `'claude-internal'` |
| RPC types | `cli/src/modules/common/rpcTypes.ts` | SpawnSessionOptions agent union |
| Runner | `cli/src/runner/run.ts` | Agent→command mapping |
| Gateway | `hub/src/sync/rpcGateway.ts` | spawnSession agent param |
| Protocol | `shared/src/modes.ts` | `AgentFlavor` type |

### 3. Dev Workdir Fix

| File | What |
|------|------|
| `cli/src/utils/spawnHappyCLI.ts` | `getSpawnWorkingDirectory()` reads `HAPI_SPAWN_CWD` |

**Why**: In dev mode, bun needs `--cwd cli/` for path alias resolution, but the actual working directory should be the user's project dir.

---

## claude-internal vs claude — Key Differences

| Behavior | `claude` | `claude-internal` |
|----------|---------|-------------------|
| Config dir | `~/.claude/` | `~/.claude-internal/` |
| `--settings` flag | Supported ✓ | **Not supported** → skip |
| Session discovery | Hook mode (instant, via `--settings`) | **Directory-scan** (3s polling) |
| `-p` / `--print` mode | Claude model | **Routes to DeepSeek** → must avoid |
| `--input-format stream-json` | Claude model ✓ | Claude model ✓ |
| Permission modes | `CLAUDE_PERMISSION_MODES` | Same (shares `isClaudeFlavor`) |
| Model options | auto/opus/opus[1m]/sonnet/sonnet[1m] | auto/opus/sonnet |

### Why Not `--print` Mode

`claude-internal -p "..."` activates Tencent's headless mode → routed to DeepSeek. Using `--input-format stream-json` keeps the process in interactive stream mode → Claude model retained.

### Session Discovery Modes

```
Hook mode (claude):
  CLI starts → --settings hook.json → SessionStart hook fires → instant session ID callback

Directory-scan mode (claude-internal):
  CLI starts → no --settings support → poll ~/.claude-internal/projects/{id}/*.jsonl every 3s
  → detect newest file by mtime → extract session ID from filename
  → ~3 second latency for session association
```

---

## Infrastructure

### Local HAPI Instances

| | `hapi` (fork) | `hapi-internal` (tencent) |
|--|---------------|--------------------------|
| CLI | `/opt/homebrew/bin/hapi` | `/opt/homebrew/bin/hapi-internal` |
| Source | `~/LProjects/ea-fork/packages/hapi` | `~/.ea/repos/_tx/tencent-hapi` |
| Branch | `eason` (6 custom commits) | `tencent` (52 internal commits) |
| Version | 0.16.4 | 0.16.69 |
| Data dir | `~/.hapi/` | `~/.hapi-internal/` |
| Hub port | **3006** | **3007** |
| Web UI | http://localhost:3006 / https://hapi.easonsi.site | http://localhost:3007 |
| Supervisor | `cc_hapi_hub` + `cc_hapi_runner` | (manual) |

Both can run simultaneously — fully isolated via `HAPI_HOME` + `HAPI_LISTEN_PORT`.

### Local Setup (Mac)

| Component | Config |
|-----------|--------|
| `hapi` CLI | `/opt/homebrew/bin/hapi` → symlink to `packages/hapi/bin/hapi` (dev wrapper) |
| Hub | supervisord `cc_hapi_hub` — `hapi hub` |
| Runner | supervisord `cc_hapi_runner` — `hapi runner start-sync` |
| SSH tunnel | LaunchAgent `com.ea.tunnel.hapi.plist` — `-R 3006:127.0.0.1:3006 tx01` |

**Dev wrapper** (`bin/hapi`):
```bash
#!/bin/bash
HAPI_SPAWN_CWD="${PWD}" HAPI_INVOKED_CWD="${PWD}" \
  exec bun --cwd .../hapi/cli .../hapi/cli/src/index.ts "$@"
```

Runs TypeScript source directly via bun — code changes take effect on next process start (no build needed). Runner/Hub need restart after code changes.

### tx01 Server

| Component | Config |
|-----------|--------|
| nginx | `/etc/nginx/conf.d/hapi.conf` → `proxy_pass http://127.0.0.1:3006` |
| TLS | certbot auto-renew, `hapi.easonsi.site` |

### Key Config Files

**Hub** (`~/.hapi/settings.json`):
```json
{
  "cliApiToken": "...",          // shared secret — same on all machines
  "machineId": "uuid",           // auto-generated per machine
  "publicUrl": "https://hapi.easonsi.site",
  "corsOrigins": ["https://hapi.easonsi.site", "http://localhost:3006"]
}
```

**Hub Database**: `~/.hapi/hapi.db` (SQLite, schema v6)

---

## Multi-Machine Setup

### Architecture

```
                    ┌─ Machine A (Mac) ─── Runner ─── claude-internal
hapi.easonsi.site   │
   Hub (:3006)  ────┤   Web UI MachineSelector dropdown
                    │
                    └─ Machine B (devcloud) ─── Runner ─── claude-internal
```

The Hub supports **multiple machines** simultaneously. Each machine:
- Has a unique `machineId` (UUID, auto-generated)
- Maintains its own Socket.IO connection
- Sends `machine-alive` heartbeat every 20s (45s timeout → offline)
- Web UI shows all online machines in a dropdown when creating sessions

### Adding a New Machine

```bash
# 1. Install hapi CLI (or use dev wrapper with bun + source)
npm install -g @anthropic-ai/hapi

# 2. Ensure claude-internal is available
which claude-internal

# 3. Configure — cliApiToken must match Hub's token
mkdir -p ~/.hapi
cat > ~/.hapi/settings.json << 'EOF'
{
  "cliApiToken": "<same token as hub>",
  "apiUrl": "https://hapi.easonsi.site"
}
EOF

# 4. Start runner (registers machine, handles spawn RPCs)
hapi runner start-sync
```

Required config:

| Key | Description | How to Get |
|-----|-------------|-----------|
| `cliApiToken` | Shared secret | Copy from Hub's `~/.hapi/settings.json` |
| `apiUrl` | Hub URL | `https://hapi.easonsi.site` or `http://host:3006` |
| `machineId` | Machine UUID | Auto-generated on first run |

---

## FAQ / Troubleshooting

### Web UI spawns `claude` instead of `claude-internal`

**Cause**: Stale Runner process. bun compiles TS at process start, doesn't hot-reload.
**Fix**: `supervisorctl restart cc:cc_hapi_runner` after code changes.

### Socket.IO 403 from hapi.easonsi.site

**Cause**: `corsOrigins` in `~/.hapi/settings.json` doesn't include `https://hapi.easonsi.site`.
**Fix**: Add both origins to `corsOrigins` array, restart Hub.

### SQLite schema mismatch (`Expected N, found M`)

**Cause**: Version upgrade changed schema. Hub doesn't run migrations.
**Fix**: `mv ~/.hapi/hapi.db ~/.hapi/hapi.db.bak && supervisorctl restart cc:cc_hapi_hub`

### `--settings` flag crashes claude-internal

**Symptom**: Session spawns then immediately dies with empty error `{}`.
**Cause**: `claude-internal` doesn't support `--settings`. Already fixed — `claudeRemote.ts` skips it when `flavor === 'claude-internal'`.

### `-p`/`--print` returns DeepSeek responses

**Cause**: Tencent routes headless mode to DeepSeek by design.
**Fix**: Never use `-p` with claude-internal. Use `--input-format stream-json` (already the default in HAPI).

### PWA shows stale web UI after code update

**Fix**: DevTools → Application → Service Workers → Unregister → Cmd+Shift+R. Or: `bun run build` in `web/` to regenerate assets.

### `Cannot find module '@/...'` when runner spawns session

**Cause**: bun path alias resolution fails when cwd ≠ `cli/`.
**Fix**: Dev wrapper uses `bun --cwd cli/` and passes real cwd via `HAPI_SPAWN_CWD` / `HAPI_INVOKED_CWD` env vars.

### Sessions from terminal `claude-internal` don't appear in web UI

**Cause**: HAPI session list comes from SQLite, not JSONL files. Only sessions spawned through HAPI (Hub → Runner → CLI) get registered.
**Status**: By design. Importing external sessions would require scanning `~/.claude-internal/projects/` and creating SQLite entries (~200-300 LOC change, P2).

### Hub shows no machines / can't spawn

**Cause**: Runner not running, or Runner connected to different Hub.
**Fix**: Verify Runner is running (`supervisorctl status cc:cc_hapi_runner`), check `apiUrl` in Runner's config matches Hub.

---

## Operations

### Restart after code changes

```bash
# Restart both Hub and Runner (code changes need process restart)
supervisorctl restart cc:cc_hapi_hub cc:cc_hapi_runner
```

### Sync upstream

```bash
cd packages/hapi
git fetch upstream
git rebase upstream/main
# Resolve conflicts (typically in claude/session.ts, claude/loop.ts, claude/runClaude.ts)
# Then restart Hub + Runner
git push origin eason --force-with-lease
supervisorctl restart cc:cc_hapi_hub cc:cc_hapi_runner
```

### Check status

```bash
# Supervisor processes
supervisorctl status | grep hapi

# Hub health
curl -s http://localhost:3006/health

# SSH tunnel
launchctl list com.ea.tunnel.hapi

# Running sessions
ps aux | grep claude-internal | grep -v grep

# Runner logs
tail -f ~/.hapi/logs/*-runner.log
```
