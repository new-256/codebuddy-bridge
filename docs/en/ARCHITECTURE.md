# Architecture

[简体中文](../ARCHITECTURE.md)

## Background: the two planes of DSH / Cordis

DSH capabilities are composed with Cordis; each capability is a plugin row in a `cordis.yml`. There are two planes:

- **Host plane**: runs in the DSH Node.js process; owns the registries, the sandbox and approval stack, persistence, the model route, the subagent registry, and anything shared across sessions. Files, networking, commands, Agent/Session access, host events and services, and model tools live here.
- **Client plane**: runs in the browser page; owns themes, layout, current page state, tool cards, and Slot UI.

An **agent preset** is what one session contributes to those registries — its tools, persona, and prompt sections. A row that publishes a service belongs to the host composition; a row that only registers into `tools` / `systemPrompt` and publishes no service is "preset-plane safe" (like `tool-fs`) and needs no isolate realm. This plugin is the latter kind.

Host and Client communicate only through package-private JSON RPC: the host exposes methods with `harness.handle(method, handler)` and the client calls them with `host.call(method, args)`. The direction is **Client → Host**.

## Component overview

```
                          ┌─────────────────────── DSH Host (Node.js) ───────────────────────┐
                          │                                                                  │
   model (any mode) ──tool call──▶ codebuddy_run / codebuddy_continue / codebuddy_status                          │
                          │        │                                                          │
                          │        ├─ buildArgv: always -p + --output-format stream-json        │
                          │        │              + --permission-mode plan/bypassPermissions
                          │        │              + mode(auto→plan/accept-edits)/model/...     │
                          │        │                                                          │
                          │        ├─ subprocess.spawn(codebuddy ...) ──────────▶ local codebuddy CLI     │
                          │        │      exec.signal + ctx.timeout→terminate() for cancel     │
                          │        │      parse stream-json events → current/trail (live)      │
                          │        │                                                          │
                          │        ├─ parse trailing result event → { ok, status, resp, sessionId }│
                          │        │                                                          │
                          │        ├─ failed & rate-limited/network? ─▶ userQuestions.ask()    │
                          │        │        fallback → { fallback:true, FALLBACK_TO_DSH }      │
                          │        │        retry    → run once more (max 2)                   │
                          │        │                                                          │
                          │        └─ update status snapshot (begin/end + foldEvent) ─┐   │
                          │                                               │                    │
                          │  systemPrompt.section('codebuddy:policy')           │ harness.handle('codebuddy_status')
                          │                                               │        ▲           │
                          └────────────────────────────────────────────────┼────────┼──────────┘
                                                                          │ host.call('codebuddy_status') every 1.2s
                          ┌──────────────── DSH Client (browser) ──────────┼────────┼───────┐
                          │  session header Slot: conversation.session.header.utilities │    │
                          │       Indicator light ──────────────────────────────────────┘    │
                          │       ● working / ok / failed / fallback / idle (theme tokens)     │
                          │       tooltip: current step + recent trail                          │
                          └───────────────────────────────────────────────────────────────────┘
```

## Host half (`dynamic/host.js` / `preset/.../codebuddy-first-bridge.mjs`)

- `inject: ['tools', 'subprocess', 'systemPrompt', 'timer']` — hard dependencies; the rest are read optionally with `ctx.get()` (`jobs` / `planMode` / `sandboxPolicy` / `userQuestions`).
- `buildArgv()` assembles the codebuddy command line, **always** including `-p`, `--output-format stream-json`, and `--permission-mode bypassPermissions` (`--permission-mode plan` in plan mode; codebuddy has no `--mode`/`--print-timeout`); with `mode:auto` it reads `planMode` to choose `plan` vs `accept-edits`.
- `runSync()` executes through `subprocess.spawn`, forwarding the caller's `exec.signal` to the child and using `ctx.timeout(() => handle.terminate(), (timeout+60)s)` as a safety net (codebuddy itself has no `--print-timeout`, so this is the only guard). While running, `startLiveParser()` incrementally reads stdout via `ctx.interval` and folds stream-json events (assistant `tool_use`/`thinking`/`text`, user `tool_result`) into `status.current` / `status.trail` (`foldEvent`) — this powers live observation.
- Executable resolution: `subprocess.resolveExecutable('codebuddy')` (discarded when it hits a `.cmd`/`.bat` shim) → `node + CODEBUDDY_BIN` → `node + %APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy` — codebuddy is usually NOT on the DSH process PATH, so the node+bin fallback is the norm.
- The background path runs through `jobs.start({ kind:'bash', owner: exec.agent, run() {...} })`; `run()` returns `{ cancel, done }`, and `done` parses the result and updates status (a live parser is attached there too).
- `parseCodeBuddyJson()` tolerantly parses codebuddy's `stream-json` output (scanning backward for the trailing `{"type":"result",...}` line, tolerating log lines; whole-string JSON as a fallback).
- The result is a single plain JSON object; `render()` produces a human-readable tool card.
- `codebuddy_status` tool / RPC returns the plain scalar snapshot `{ state, running, current, trail, lastStatus, lastSessionId, runs, totalTokens, updatedAt, projects[] }`; `projects[]` is sectioned per project (cwd), each section carrying that project's `current` (the step executing right now — tool name + arguments, or thinking/typing), `trail`, `lastStatus`, `runs`/`totalTokens` (project-cumulative call count and token usage — codebuddy has no plan/quota API, so token metering is the substitute), etc.; the top-level fields are the global aggregation (backward compatible). A `cwd` argument filters to a single project.

### Key constraints (sandbox vs real Node)

| Constraint | Dynamic plugin (sandbox) | Preset `.mjs` (real Node) |
| --- | --- | --- |
| `import` / `require` | ❌ forbidden | ⚠️ available, but **cannot reach** `@deepseek-ai/*` (an upward search from the user home never finds the harness packages), so the module is **dependency-free** |
| `AbortController` | ❌ absent (use `exec.signal` + `handle.terminate()`) | ✅ present, but the same approach is kept for parity |
| `process` / `Buffer` / native timers | ❌ absent | ✅ present (unused) |
| Tool registration | `harness.registerTool(ctx, harness.defineTool({...}))` | `ctx.tools.register(<plain ToolDefinition object>)` |
| Host→Client RPC | `harness.handle('codebuddy_status', ...)` | ⚠️ no client half, so not registered (and no consumer) |

> This is why **the status light cannot come from the preset**: a preset is a host-plane composition whose `.mjs` runs only on the Node side and has no browser UI; the live light is a client-plane Slot component. **This project solves persistence with a home-level plugin form** (see below).

## Home-level status-light plugin (`home-plugin/codebuddy-indicator/`, v1.0.0+; one single light)

The status light no longer depends on an in-session dynamic plugin (lost on restart); it is registered through `cordis.patch.yml` as a **home-level plugin** that starts with the software, appears in every session, and needs no approval:

```
In-session codebuddy-first-bridge (preset, real Node module)          DSH Host (root realm)
  begin/end/foldStepUpdate ── ctx.emit('codebuddy/status', {snapshot})
                                          │  (events are app-level broadcasts; isolate realms isolate services only)
                                          ▼
                        codebuddy-indicator host half (lib/index.mjs)
                          ctx.on('codebuddy/status') → global projects[cwd] table
                          webServer.register({kind:'exact', path:'/codebuddy-indicator/status'})
                                          │  GET → JSON {state, running, projects[]}
                                          ▼
                        DSH Client (browser)
                          codebuddy-indicator client half (lib/client.js, roster module)
                          fetch('/codebuddy-indicator/status') every 1.2s → render one light per project
```

- host half `lib/index.mjs`: `ctx.on('codebuddy/status')` collects snapshots and merges them by cwd into a global project table (idle projects untouched for 10 minutes are filtered out; max 24); exposes `GET /codebuddy-indicator/status` via `webServer`.
- client half `lib/client.js`: `window.__ModuleLoader__.load({id, factory})` format (same as `dsh-model-status`), mounted in `conversation.session.header.utilities`, polls the HTTP route and renders.
- **Two data channels coexist**: the preset (real module) pushes via `ctx.emit` (standard Cordis API); the dynamic sandbox has no `ctx.emit`, so its client half uses its own `host.call('codebuddy_status')` RPC. They do not interfere and show the same content.
- `cordis.patch.yml` hot-reloads via Cordis HMR: bump `?v=N` after editing `lib/index.mjs`; refresh the browser after editing `lib/client.js`.

## Client half (`dynamic/client.js`)

- An **empty skeleton**: the dynamic form does not register its own header light (that would duplicate the home-level one); all UI is rendered by the home-level `codebuddy-indicator`, and the dynamic host half pushes state into the home-level collector via `ctx.get('codebuddyCollector').mergeSnapshot(snapshot())`.

## Shared core and derived artifacts (v1.0.0+)

The three delivery forms do not each carry a copy of the core logic (copy-paste maintenance across forms is a breeding ground for field-level drift); the code converges into a **single source of truth + generated derived artifacts + a sync-lock test**:

```
core/codebuddy-core.mjs (single source of truth: pure functions + createStatusEngine
                         + createLineStream + createRunner orchestration + shared copy;
                         no process/env/import)
   ├─ direct import (MCP server, runs from the repo)
   ├─ generated copy preset/codebuddy-first/codebuddy-core.mjs (verbatim copy by
   │   scripts/build.mjs; the preset imports './codebuddy-core.mjs' relatively
   │   → the install dir is self-contained)
   └─ text injection into dynamic/host.js (scripts/build.mjs strips the export
       keywords from core and injects it at host.template.mjs's /*__CORE__*/
       marker — the dynamic sandbox forbids import, so it must be self-contained)
```

- The three forms keep only their **host adapter layers**: preset (`ctx.tools.register` + `ctx.emit` events + `process.env`-style exe resolution), dynamic (`harness.registerTool` + collector push + sandbox-safe exe resolution), MCP (stdio JSON-RPC + cwd whitelist + text rendering).
- `scripts/build.mjs --check` (run by CI and `npm test`) regenerates both artifacts and compares against disk: a commit that changes core or the template without regenerating fails — the "fix two, miss one" drift source is closed (`test/build-sync.test.mjs`).
- Usage accounting (`runs`/`totalTokens`) lives in the status engine's `end()`: each completed call accumulates per project; codebuddy has no plan/quota API, so token metering is the substitute.

## Lifecycle and reversibility

Every side effect is attached to the current fiber and reclaimed on `cordis_stop` / `cordis_undefine` / preset unload:

- tools: `ctx.tools.register(...)` / `harness.registerTool(...)` return disposers;
- prompt section: `ctx.systemPrompt.section(...)`;
- styles: `styles.insert(...)` (wrapped in `ctx.effect`);
- timers: `ctx.timeout(...)` / `ctx.interval(...)` return disposers.

## Data discipline

The plugin never serializes DSH live objects (Service / Event / Slot / Session). It reads only the leaf fields it needs (codebuddy's stdout text, exit code, etc.) and builds the smallest owned JSON object, free of host references, to cross the RPC boundary and render.
