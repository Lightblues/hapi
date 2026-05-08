# tencent-hapi — Tencent Internal HAPI Fork

Tencent's internal fork of [tiann/hapi](https://github.com/tiann/hapi) with multi-user auth, ASR, and internal agent support.

- **Repo**: `~/.ea/repos/_tx/tencent-hapi` (branch `tencent`, origin `git@git.woa.com:ViteOps/tencent-hapi.git`)
- **CLI**: `hapi-internal` (port 3007, data `~/.hapi-internal/`)
- **Version**: 0.16.69 (52 commits ahead of upstream main)

---

## Differences from Upstream

### Multi-User Token System

Upstream uses a single shared `cliApiToken`. Tencent adds a full token registry:

| Component | File | Description |
|-----------|------|-------------|
| Token store | `hub/src/store/tokenStore.ts` | SQLite-backed token CRUD with namespace isolation |
| Token verifier | `hub/src/utils/tokenVerifier.ts` | Verify + resolve namespace from token |
| Admin API | `hub/src/web/routes/admin.ts` | Create/revoke/list tokens (admin-only) |
| Registration | `hub/src/web/routes/register.ts` | Self-service token registration flow |

### ASR (Speech-to-Text)

| Component | File | Description |
|-----------|------|-------------|
| WebSocket proxy | `hub/src/` | Reverse proxy to `tangredtea.devcloud.woa.com:3002` |
| Client hook | `web/src/hooks/useAsrWebSocket.ts` | Real-time speech recognition with silence auto-stop |
| UI integration | Web composer | Microphone button, real-time transcription rendering |

### Internal Agent Commands

| Command | File | Description |
|---------|------|-------------|
| `hapi codebuddy` | `cli/src/commands/codebuddy.ts` | CodeBuddy agent wrapper |
| `hapi codex-internal` | `cli/src/commands/codexInternal.ts` | Internal Codex variant |
| `hapi gemini-internal` | `cli/src/commands/geminiInternal.ts` | Internal Gemini variant |
| `hapi admin` | `cli/src/commands/admin.ts` | Admin CLI for token management |

### Other Changes

| Change | Detail |
|--------|--------|
| Message retention | Reduced from 500 → 250 per session |
| Directory-scan fixes | Concurrency safety, stub file lock fix |
| Watchdog | Exponential backoff to prevent crash loops |
| Hub npm package | Published as `@tencent/hapi-hub` with standalone binary |
| Default API URL | `http://mycli.development.polaris` (Tencent internal) |

---

## Isolation Setup

`hapi-internal` is fully isolated from `hapi` (fork) via environment variables:

| Dimension | `hapi` (fork) | `hapi-internal` (tencent) |
|-----------|---------------|--------------------------|
| CLI command | `hapi` | `hapi-internal` |
| Source | `~/LProjects/ea-fork/packages/hapi` | `~/.ea/repos/_tx/tencent-hapi` |
| Branch | `eason` | `tencent` |
| Version | 0.16.4 | 0.16.69 |
| Data dir | `~/.hapi/` | `~/.hapi-internal/` |
| Hub port | **3006** | **3007** |
| `cliApiToken` | Independent | Independent |
| `machineId` | Independent | Independent |
| SQLite DB | `~/.hapi/hapi.db` | `~/.hapi-internal/hapi.db` |

### Wrapper Script

`/opt/homebrew/bin/hapi-internal` → `~/.ea/repos/_tx/tencent-hapi/bin/hapi-internal`:

```bash
#!/bin/bash
export HAPI_HOME="${HAPI_HOME:-$HOME/.hapi-internal}"
export HAPI_LISTEN_PORT="${HAPI_LISTEN_PORT:-3007}"
HAPI_SPAWN_CWD="${PWD}" HAPI_INVOKED_CWD="${PWD}" \
  exec bun --cwd .../tencent-hapi/cli .../tencent-hapi/cli/src/index.ts "$@"
```

### Usage

```bash
# Start tencent-hapi hub (port 3007)
hapi-internal hub

# Start runner
hapi-internal runner start-sync

# Direct session
hapi-internal claude-internal

# Access web UI
open http://localhost:3007
```

Both `hapi` (port 3006) and `hapi-internal` (port 3007) can run simultaneously.

---

## Sync Upstream

tencent-hapi tracks upstream via `origin/main`. The `tencent` branch rebases on top:

```bash
cd ~/.ea/repos/_tx/tencent-hapi
git fetch origin
git checkout tencent
git rebase origin/main
```
