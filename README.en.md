# codebuddy-first-bridge

[简体中文](README.md) · **English**

> A Cordis plugin for the **DeepSeek Harness (DSH)** that makes the model **prefer the local `codebuddy` CLI** (Tencent CodeBuddy Code) for real work (coding, builds, debugging, multi-file investigation) across **every mode**. DSH stays fully in control of codebuddy (`--permission-mode bypassPermissions`, so codebuddy never prompts). When codebuddy is **rate-limited or the network is down**, it pops a confirmation dialog asking whether to fall back to the **DSH local API config**, and it shows a **live status light** in the session header indicating whether codebuddy is currently working.

![codebuddy status light states](assets/indicator-states.svg)

---

## What it is

`codebuddy-first-bridge` contributes two things to a running DSH session:

1. **Three model tools** — `codebuddy_run`, `codebuddy_continue` and `codebuddy_status`, which hand tasks to the local `codebuddy` CLI.
2. **An codebuddy-first policy prompt section** — instructs the model to prefer codebuddy for real work in **all modes** (normal / plan / accept-edits / subagent / workflow / ralph / goal rounds); native tools are reserved for read-only lookups and final verification.

On top of that it implements the key capabilities that motivated the project:

- **Fallback mechanism (confirmation dialog):** when codebuddy looks rate-limited or the network is unreachable, a dialog pops up offering *"use the DSH local API config (fall back)" / "retry codebuddy once" / "do not fall back"*.
- **Live status lights (per project, start-up persistent):** coloured indicators on the right of the browser session header — **one per project (working directory)** — reflecting each project's codebuddy activity in real time (working / ok / failed / fallback); hovering shows the step that project's codebuddy is currently executing. The light is a **home-level plugin** ([`home-plugin/codebuddy-indicator/`](home-plugin/codebuddy-indicator/), registered via `cordis.patch.yml`): it loads automatically with DSH, appears in **every session**, and needs **no approval**.
- **Live observation (`codebuddy_status`):** the `codebuddy_status` tool returns a snapshot of what codebuddy is doing RIGHT NOW, sectioned per project — each project's current step (tool name + arguments, or thinking/typing), recent step trail, last completed run. Optional `cwd` filters to one project. Callable mid-flight, no waiting.

## Four forms

The same logic ships in four forms; pick per need:

| Form | Location | Capabilities | Survives restart | Status light |
| --- | --- | --- | --- | --- |
| **Persistent agent preset** (recommended) | [`preset/codebuddy-first/`](preset/codebuddy-first/) | tools + policy + fallback dialog + `codebuddy_status` | ✅ yes (persisted preset) | ❌ no (host-plane composition has no browser UI) |
| **Home-level status-light plugin** (start-up persistent) | [`home-plugin/codebuddy-indicator/`](home-plugin/codebuddy-indicator/) | status light (every session, no approval) | ✅ yes (cordis.patch.yml) | ✅ yes |
| **Dynamic Cordis plugin** (in-session) | [`dynamic/`](dynamic/) | tools + policy + fallback dialog + **status light** + `codebuddy_status` | ❌ no (process-local) | ✅ yes (one-time approval) |
| **MCP server** (any MCP host) | [`mcp/`](mcp/) | `codebuddy_run` / `codebuddy_continue` / `codebuddy_status` auto-discovered via `tools/list` by Claude Code, Codex, Cherry Studio, … | ✅ yes (registered in client config) | ❌ no |

> **Why does the status light need a home-level plugin?** An agent preset is a **host-plane** composition (`agent.cordis.yml` mounts host plugins), and its `.mjs` runs only on the Node side, so it inherently has no browser UI. The live status light is a **client-plane** (browser Slot) component. A **home-level plugin** (registered via `cordis.patch.yml`, e.g. [`home-plugin/codebuddy-indicator/`](home-plugin/codebuddy-indicator/)) provides both a host half (collecting codebuddy status pushed by each session + an HTTP route) and a client half (the browser poll-and-render light), so it loads with DSH, appears in every session and needs no approval. The dynamic form (one-time GUI approval) and the home-level light coexist: both feed the home-level collector (the dynamic form via `codebuddyCollector.mergeSnapshot`, the preset form via `ctx.emit('codebuddy/status')` events).
>
> The fallback dialog is a host-side capability and is present in **both** the preset and dynamic forms. The MCP form has no UI; on rate-limit it appends a "don't loop-retry" note to the result text and lets the calling agent decide.

See [docs/en/ARCHITECTURE.md](docs/en/ARCHITECTURE.md).

## Quick start

### Option A: install as a persistent agent preset (recommended)

Copy the whole `preset/codebuddy-first/` directory into your DSH user preset root:

```
${DSH_HOME:-$HOME/.dsh}/.agent-presets/codebuddy-first/
```

Windows example (this repo's dev environment):

```powershell
Copy-Item -Recurse .\preset\codebuddy-first "$env:DSH_HOME\.agent-presets\codebuddy-first"
```

Then start a new DSH session and select the preset named **`CodeBuddy-First 执行代理`** (id: `codebuddy-first`). It inherits everything from the `standard` preset and adds the `codebuddy_run` / `codebuddy_continue` / `codebuddy_status` tools, the codebuddy-first policy, and the rate-limit/network fallback dialog.

> ⚠️ **Do not** edit the shipped `agent-presets` install that ships with the deployment (an upgrade overwrites it). Always install under your **user** preset root as a separate subdirectory.

Full steps and validation are in [docs/en/INSTALL.md](docs/en/INSTALL.md).

### Option B: install the home-level status-light plugin (start-up persistent, every session)

Copy [`home-plugin/codebuddy-indicator/`](home-plugin/codebuddy-indicator/) into the DSH home plugin directory and register it in `cordis.patch.yml`; the light then loads automatically with DSH, appears in every session, and needs no approval:

```powershell
# 1) copy the plugin source
$dshHome = "$env:APPDATA\DSH Desktop\dsh-home"
Copy-Item -Recurse .\home-plugin\codebuddy-indicator "$dshHome\plugins\codebuddy-indicator"

# 2) create junctions (needed by both host resolution and the browser roster; 3 in total)
New-Item -ItemType Junction -Path "$dshHome\node_modules\codebuddy-indicator" -Target "$dshHome\plugins\codebuddy-indicator"
New-Item -ItemType Junction -Path "$dshHome\profiles\node_modules\codebuddy-indicator" -Target "$dshHome\plugins\codebuddy-indicator"
New-Item -ItemType Junction -Path "$dshHome\profiles\web\node_modules\codebuddy-indicator" -Target "$dshHome\plugins\codebuddy-indicator"

# 3) append two rows to cordis.patch.yml (HMR hot-reloads, no restart needed):
#    - insert:
#        - id: codebuddy-indicator
#          name: file:///.../plugins/codebuddy-indicator/lib/index.mjs?v=1
#    - insert:
#        - id: codebuddy-indicator-client
#          name: codebuddy-indicator
```

Pair it with the **preset form** (Option A): the preset's `codebuddy-first-bridge.mjs` emits `ctx.emit('codebuddy/status')` on every state change, which the home-level collector merges and the light renders. After editing `lib/index.mjs`, bump `?v=N` to hot-reload; after editing `lib/client.js`, refresh the browser.

### Option C: run as a dynamic Cordis plugin (with the status light)

In a DSH session that has Cordis capabilities loaded, define and activate the plugin with `cordis_define` + `cordis_run`, using [`dynamic/host.js`](dynamic/host.js) for the host half and [`dynamic/client.js`](dynamic/client.js) for the client half. The first time the client half runs, the DSH GUI asks for a one-time approval; once granted, the status light appears in the session header.

## Requirements

- **DeepSeek Harness (DSH)** with the needed host services mounted: `tools`, `subprocess`, `systemPrompt`, `timer` (optional: `jobs`, `planMode`, `sandboxPolicy`, `userQuestions`).
- A local **`codebuddy` CLI** (CodeBuddy Code, `npm i -g @tencent-ai/codebuddy-code`; verified against v2.143.0 during development). **No PATH requirement**: the bridge resolves `subprocess.resolveExecutable('codebuddy')` → `node + CODEBUDDY_BIN` → `node + %APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`, so a plain npm global install is found.
- The DSH Web GUI (client plane) is additionally required for the status light.

## Tool usage

`codebuddy_run(prompt, mode?, model?, effort?, maxTurns?, cwd?, addDirs?, timeoutSec?, background?, backend?)`

- `backend`: **dual-backend dispatch** (v1.1.0). `codebuddy` (default — CodeBuddy Code, coding scenarios) or `workbuddy` (Tencent WorkBuddy, the same-engine office-scenario sibling: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies). The two CLIs keep separate session stores; `codebuddy_continue` routes back to the backend owning the sessionId automatically — an explicit `backend` always wins.
- `mode`: `auto` (default — follows DSH plan state, choosing `plan`/`accept-edits`), `plan`, `accept-edits`.
- `effort`: `minimal / low / medium / high / xhigh / max`; optional `maxTurns` (1-500, default unlimited).
- `background: true`: run as a background job and return a `jobId`; collect via `job_output`.
- Returns: `{ ok, status, response, sessionId, durationSeconds, numTurns, totalTokens, exitCode, mode, backend, stderr }`; on fallback it is `{ ok:false, fallback:true, status:'FALLBACK_TO_DSH', ... }`.

`codebuddy_continue(prompt, sessionId? | latest?, ...)` — continue an existing conversation (`--resume <sessionId>` / `--continue`); other parameters as above; without an explicit `backend` it routes to the CLI owning the sessionId.

`codebuddy_status(cwd?)` — **live observation + usage accounting**: returns a snapshot of what codebuddy is doing right now (`{ state, running, current, trail, lastStatus, lastSessionId, runs, totalTokens, updatedAt, projects[] }`). `projects[]` is sectioned per project (working directory): `current` is the step that project is executing right now (tool name + arguments, or thinking/typing); `trail` is its recent step history; `runs`/`totalTokens` are the **project-cumulative call count and token usage** (codebuddy has no plan/quota API, so token metering is the available substitute). Optional `cwd` filters to one project. Callable while `codebuddy_run`/`codebuddy_continue` is in flight, no waiting.

## DSH fully controls codebuddy

Every codebuddy call is forced with `-p`, `--output-format stream-json` and `--permission-mode bypassPermissions` (`--permission-mode plan` in plan mode), so **codebuddy never prompts and never asks before editing files**; mode, model, effort, working directory, timeout, background, and cancellation are all decided by DSH, and a run can be cancelled through `exec.signal` + `handle.terminate()`. codebuddy has no `--print-timeout`; a DSH-side hang guard force-terminates at `timeoutSec+60s` (`HUNG_TIMEOUT`). Each stream-json event (assistant `tool_use`/`thinking`/`text`, user `tool_result`) feeds the `codebuddy_status` snapshot in real time.

## Fallback & status light

See [docs/en/FALLBACK-AND-INDICATOR.md](docs/en/FALLBACK-AND-INDICATOR.md). Highlights:

- Failure detection: non-zero exit, or `stderr/status` matching `rate limit / 429 / quota / ECONN* / network / timeout / …` (plus Chinese equivalents) — **stderr and status only, never the answer text** (investigation answers almost always mention connection/dns/timeout; numeric codes are word-bounded so "1500" does not match 500).
- The dialog uses DSH's `userQuestions.ask()`; when there is no live human answerer (e.g. a delegated subagent) the dialog is skipped and an error is returned, avoiding a permanent block.
- Each rate-limit/network failure opens the 3-way dialog once; "Retry" is offered only while retries remain (at most 2 attempts); background failures do not open the dialog (re-run in the foreground to be prompted).
- The status light polls the home-level HTTP route `GET /codebuddy-indicator/status` every 1.2s; colours come from theme tokens and adapt to light/dark.

## Repository layout

```
codebuddy-first-bridge/
├─ README.md / README.en.md
├─ LICENSE
├─ .gitignore
├─ package.json                    # version metadata (v1.1.0, Node >=18) + scripts (build/test/check)
├─ MCP-POLICY.md                   # disclose-and-prefer policy for external agents (also ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md)
├─ .github/workflows/ci.yml       # node --check + test suite + version/YAML structural validation (Node 18/20/22)
├─ assets/indicator-states.svg    # status-light states diagram
├─ core/
│  └─ codebuddy-core.mjs           # ★ shared core (single source of truth): pure functions + status engine
│                                  #   + line stream + run orchestration + shared copy
├─ scripts/
│  ├─ build.mjs                    # generates derived artifacts (dynamic/host.js text injection + preset core copy)
│  └─ verify.mjs                   # version triple-lock (package.json ↔ MCP VERSION ↔ CHANGELOG) + YAML assertions
├─ test/                           # node:test suite (44 cases: pure functions / sandbox sim / preset / MCP e2e / sync lock)
│  ├─ helpers/mockdsh.mjs          #   DSH host-shape stand-ins (ctx/harness/subprocess/userQuestions)
│  ├─ fixtures/fake-codebuddy.mjs  #   fake codebuddy CLI (MCP e2e fixture)
│  └─ *.test.mjs
├─ preset/
│  └─ codebuddy-first/                   # persistent agent preset (recommended)
│     ├─ preset.yml
│     ├─ agent.cordis.yml          #   standard + one codebuddy plugin row
│     ├─ codebuddy-first-bridge.mjs      #   host adapter (tool registration / event publish / env resolution)
│     └─ codebuddy-core.mjs        #   [generated] core copy — the preset install dir is self-contained
├─ home-plugin/
│  └─ codebuddy-indicator/               # home-level status-light plugin (start-up persistent)
│     ├─ package.json              #   dsh.client declaration (browser roster)
│     └─ lib/
│        ├─ index.mjs              #   host half: collects codebuddy/status events + HTTP route
│        ├─ client-entry.mjs       #   bare-name placeholder entry (prevents double-loading index.mjs)
│        └─ client.js              #   browser half: poll + render per-project light
├─ dynamic/                        # dynamic Cordis plugin form (with status light)
│  ├─ host.template.mjs            #   adapter template (with the /*__CORE__*/ injection point)
│  ├─ host.js                      #   [generated] code.host body (core text injected — do not edit by hand)
│  └─ client.js                    #   code.client body (empty skeleton: UI unified in the home-level light)
├─ mcp/                            # MCP server (discoverable by any MCP host)
│  ├─ codebuddy-mcp-server.mjs           #   zero-dependency stdio MCP server (host adapter layer)
│  └─ README.md                    #   registration (Claude Code / Codex / DSH / generic) + security guardrail
└─ docs/
   ├─ INSTALL.md / ARCHITECTURE.md / FALLBACK-AND-INDICATOR.md / CHANGELOG.md   (中文)
   └─ en/INSTALL.md / ARCHITECTURE.md / FALLBACK-AND-INDICATOR.md               (English)
```

> **Derived-artifact convention**: `dynamic/host.js` and `preset/codebuddy-first/codebuddy-core.mjs` are generated. Change shared logic in `core/`, dynamic adapters in `host.template.mjs`, then run `npm run build` (the sync lock inside `npm test` fails the commit if you forget).

## Versions & releases

Semantic versioning via `package.json` + Git tags + GitHub Releases (see [docs/CHANGELOG.md](docs/CHANGELOG.md)):

| Version | DSH compat | Highlights |
| --- | --- | --- |
| [v1.1.4](https://github.com/new-256/codebuddy-bridge/releases/tag/v1.1.4) | Desktop 0.3.4+ (verified 0.3.14) / dsh 0.1.2-alpha.4+ | **Fixes rough dispatch in standard mode**: the CLI's own `error_during_execution` transient failure was previously neither retried nor explained (a failure returned a single head line), so the caller burned a `codebuddy_status` call and then guessed its way to an explicit `model`. Verified by reproduction: the same task on the same default model (`hy4-preview`) succeeded on a rerun, confirming a CLI/service-side transient fault rather than a bad model or a bad task. Now: ① transient errors are **silently retried once** (both the preset and MCP paths; kept separate from rate-limit/network failures, which still ask the user because retrying may just burn quota; resume/continue calls are never auto-retried); ② failures always carry **actionable guidance** (retry / switch model / finish with native tools); ③ the result head records the **model actually used** (`model=…`) plus `retried=1`, so diagnosing the default model no longer requires guesswork. Tests 66→68 |
| [v1.1.3](https://github.com/new-256/codebuddy-bridge/releases/tag/v1.1.3) | Desktop 0.3.4+ (verified 0.3.14) / dsh 0.1.2-alpha.4+ | **Two fixes**: ① **plan-mode Bash gate** — under DSH plan mode the CLI denies Bash in `-p` non-interactive + `plan` (that tier needs interactive approval, and nobody can grant it non-interactively), so codebuddy reported "the Bash tool is not authorized in non-interactive mode (denied), so I used PowerShell instead" — the same shell class, gated inconsistently, burning turns and sometimes abandoning the investigation; plan mode now also passes `--allowedTools Bash` to **pre-approve** read-only shell. Verified: Bash works again while **writes stay blocked by plan mode itself** (the read-only guarantee holds), and `Read`/`Grep` are unaffected. ② **per-session light detection moved to host-side live enumeration** — no longer depending on the DSH client summary's `agentPreset` (default sessions simply lack that field → "unknown" → global-lease fallback → normal sessions still lit; and the field's location drifts across DSH versions): the home plugin now computes the codebuddy-first session list itself via `agents.list()` + `agentPresets.composedPreset()` and returns it from the endpoint, **taking effect immediately for already-open sessions**; that list and the client-summary channel form a dual channel where **either positive wins**, a safety valve so a sessionId mismatch degrades to "light off" instead of "never lights"; the preset also reports its sessionId as a fallback, and closing a session clears its light at once. Tests 58→66 |
| [v1.1.2](https://github.com/new-256/codebuddy-bridge/releases/tag/v1.1.2) | Desktop 0.3.4+ (verified 0.3.5 & 0.3.14) / dsh 0.1.2-alpha.4+ | **Adapted to DSH Desktop 0.3.14 / dsh 0.1.2-alpha.5**. After the DSH plugin-system rework the client session summary's `agentPreset` moved into `projectionValues` and slot `inject` became zero-arg, silently breaking v1.1.1's per-session idle-light check (regressing to a global light); fixed with a **dual channel**: framework standard props first (`sessionId` + the `useSessions` selector hook reading `projectionValues.agentPreset`), falling back to the legacy `inject(sessionId)` + `sessions.list` snapshot, both readers accepting old and new summary shapes; the home plugin's package.json now declares `dsh.compat` (desktop/backend/verified); README version table gains a DSH-compat column and past releases are labeled with their DSH versions; combo-roster + HMR content-fingerprint verification byte-exact on 0.3.14 |
| [v1.1.1](https://github.com/new-256/codebuddy-bridge/releases/tag/v1.1.1) | Desktop 0.3.5 (developed/verified); compatible with 0.3.14 (per-session channel needs v1.1.2) | **Fix: status light stuck on in non-codebuddy-first sessions** (both layers fixed): ① the home-level plugin's `presetActive` was a sticky flag — once any session had loaded the codebuddy-first preset since DSH started, every session showed a permanent "CB ready" light; now a **heartbeat lease** (preset announces every 30s; TTL 75s; `active:false` clears immediately) that goes out within ≤75s after the last codebuddy-first session closes. ② the idle "CB ready" light is now **per-session** — the client reads its own session's `agentPreset` from the `sessions.list` snapshot and shows the idle light only in sessions that are actually codebuddy-first, while activity pills stay global; the host-half state machine extracted into a testable `createIndicatorState()` with first-ever test coverage. Tests 49→58 |
| [v1.1.0](https://github.com/new-256/codebuddy-bridge/releases/tag/v1.1.0) | Desktop 0.3.5 | **Dual backend: WorkBuddy**. `backend="workbuddy"` dispatches office tasks (documents/slides/spreadsheets, knowledge base, image/video generation, WeChat/WeCom replies) to Tencent WorkBuddy — a **same-engine twin CLI** of CodeBuddy (identical stream-json protocol, verified field-by-field), sharing login with the desktop app. **Session-aware backend routing**: the two CLIs keep separate session stores; continuing a session routes back to the owning CLI automatically. Results carry a `backend` field; status shows a `[workbuddy]` tag; the MCP server returns an install-hint error when WorkBuddy is missing. Test suite extended to 49 |
| [v1.0.0](https://github.com/new-256/codebuddy-bridge/releases/tag/v1.0.0) | Desktop 0.3.5 | **First official release**: `codebuddy_run` / `codebuddy_continue` / `codebuddy_status` tools + codebuddy-first policy + fallback dialog + home-level live status light + dynamic form + zero-dependency MCP server (with the `CODEBUDDY_MCP_ALLOWED_ROOTS` whitelist guard) + per-project token usage accounting (codebuddy exposes no quota API — token metering as the substitute) + `model`/`effort`/`maxTurns` selection; a shared `core/` (single source of truth + generated derived artifacts + sync-lock); a reliability baseline (status tool survives every failure path, session-aware cwd fallback, single-shot dialog, background hang guard, narrowed rate-limit detection, cross-chunk half-line-safe parsing) locked by 44 fault-injection regression tests, CI syntax matrix + tests + version triple-lock |

## Security notes

- `--permission-mode bypassPermissions` means codebuddy will edit files and run commands without asking again. This is the direct implementation of the "DSH fully controls codebuddy" requirement; use it only where you trust codebuddy's execution environment. The MCP form can restrict working directories via `CODEBUDDY_MCP_ALLOWED_ROOTS` (see [`mcp/README.md`](mcp/README.md)).
- The plugin only registers into the host `tools` / `systemPrompt` registries and exposes one package-private read-only `codebuddy_status` JSON method; it publishes no cross-session service, so it is safe on the preset plane (no isolate realm needed).
- All side effects (tool registration, prompt section, styles, timers) are attached to the current fiber via `ctx.effect` / `ctx.tools.register` / `ctx.timeout`, and are cleaned up automatically on stop / update / undefine.

## License

[MIT](LICENSE) © 2026 chenglong
