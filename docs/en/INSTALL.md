# Installation

This plugin ships in three forms, combinable:

1. **Persistent agent preset** — tools + policy + fallback dialog + `codebuddy_status` (most users' first choice);
2. **Home-level status-light plugin** (v1.0.0+) — the status light starts with the software, appears in every session, needs no approval (pair with Option A, see Option B);
3. **Dynamic Cordis plugin** — process-local temporary form that also brings its own browser status light (one-time approval, see Option C).

**Recommended combo: Option A + Option B** — install once, tools plus a persistent status light, ready when DSH starts.

[简体中文](../INSTALL.md)

---

## Prerequisites

- A working **DeepSeek Harness (DSH)**.
- The **`codebuddy` CLI** installed (`npm i -g @tencent-ai/codebuddy-code`; verified during development: v2.143.0). **No PATH requirement** — the bridge resolves `subprocess.resolveExecutable('codebuddy')` (skipping `.cmd` shims) → `node + CODEBUDDY_BIN` → `node + %APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`, so a plain npm global install is found:

  ```bash
  codebuddy --version   # verified during development: v2.143.0
  ```

- These host services mounted in the session composition (the `standard` preset has them all):
  `tools`, `subprocess`, `systemPrompt`, `timer`; optional enhancements:
  `jobs` (background jobs), `planMode` (auto plan detection), `sandboxPolicy` (default cwd), `userQuestions` (fallback dialog).

---

## Option A: persistent agent preset (recommended)

### 1. Find your user preset root

Presets live under:

```
${DSH_HOME:-$HOME/.dsh}/.agent-presets/
```

When `DSH_HOME` is unset it falls back to `$HOME/.dsh`. In this repo's dev environment it is:

```
C:\Users\<you>\AppData\Roaming\DSH Desktop\dsh-home\.agent-presets\
```

> Use DSH's `agentPresets` service (`list()` / `resolve()`) to read each preset's real path at runtime; do not assume it.

### 2. Copy the preset directory

```powershell
# Windows PowerShell
Copy-Item -Recurse .\preset\codebuddy-first "$env:DSH_HOME\.agent-presets\codebuddy-first"
```

```bash
# macOS / Linux
cp -R ./preset/codebuddy-first "${DSH_HOME:-$HOME/.dsh}/.agent-presets/codebuddy-first"
```

After copying, the directory should be:

```
.agent-presets/codebuddy-first/
├─ preset.yml
├─ agent.cordis.yml
└─ codebuddy-first-bridge.mjs
```

### 3. (Optional) check the working-directory default

`codebuddy-first-bridge.mjs` has a fallback constant near the top:

```js
const CWD_FALLBACK = 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'
```

It is only used when the session provides no `sandboxPolicy.workspaceRoot` and the call passes no explicit `cwd`. Change it to your default working directory if you like (usually unnecessary).

### 4. Validate that it mounts

In a session with Cordis capabilities, run a mount check via `agentPresets.standingKeyFor('codebuddy-first')`; success means the module imported correctly, both tools registered, the prompt section assembled, and no root-realm conflict was triggered.

You can also do a quick syntax self-check:

```bash
node --check ./preset/codebuddy-first/codebuddy-first-bridge.mjs
```

### 5. Use it

Start a new session and select the preset **`CodeBuddy-First 执行代理`** (id: `codebuddy-first`). You get everything from `standard`, plus the `codebuddy_run` / `codebuddy_continue` / `codebuddy_status` tools, the codebuddy-first policy, and the rate-limit/network fallback dialog.

> **Important: never edit the shipped `agent-presets` install** that comes with the deployment (it is overwritten on upgrade, and corrupting factory presets such as `cordis` can even disable that mode). Always install under your **user** preset root as a separate subdirectory.

---

## Option B: home-level status-light plugin (start-up persistent, every session, v1.0.0+)

Install [`home-plugin/codebuddy-indicator/`](../../home-plugin/codebuddy-indicator/) as a DSH home-level plugin; the light then loads automatically with DSH, appears in every session and needs no approval. **Pair with Option A**: the preset emits `ctx.emit('codebuddy/status')` on every state change, the home-level collector merges it and exposes it via an HTTP route, and the browser light polls and renders it.

```powershell
$dshHome = "$env:APPDATA\DSH Desktop\dsh-home"   # or your DSH home directory

# 1) copy the plugin source
Copy-Item -Recurse .\home-plugin\codebuddy-indicator "$dshHome\plugins\codebuddy-indicator"

# 2) create junctions (needed by both host resolution and the browser roster; 3 in total)
New-Item -ItemType Junction -Path "$dshHome\node_modules\codebuddy-indicator" -Target "$dshHome\plugins\codebuddy-indicator"
New-Item -ItemType Junction -Path "$dshHome\profiles\node_modules\codebuddy-indicator" -Target "$dshHome\plugins\codebuddy-indicator"
New-Item -ItemType Junction -Path "$dshHome\profiles\web\node_modules\codebuddy-indicator" -Target "$dshHome\plugins\codebuddy-indicator"

# 3) append two rows to cordis.patch.yml (Cordis HMR hot-reloads, no restart needed):
#    - insert:
#        - id: codebuddy-indicator
#          name: file:///.../plugins/codebuddy-indicator/lib/index.mjs?v=1
#    - insert:
#        - id: codebuddy-indicator-client
#          name: codebuddy-indicator
```

Verification:

```powershell
# host route (the light's data source)
Invoke-WebRequest -Uri "http://127.0.0.1:<DSH port>/codebuddy-indicator/status"   # → {"state":"idle","running":0,"projects":[]}

# client module is in the browser roster
Invoke-WebRequest -Uri "http://127.0.0.1:<DSH port>/plugins/codebuddy-indicator/client.js"  # → 200
```

After editing `lib/index.mjs`, bump `?v=N` to hot-reload; after editing `lib/client.js`, refresh the browser.

---

## Option C: dynamic Cordis plugin (process-local temporary form)

The dynamic form is a process-local plugin that **disappears on restart**, but it brings its own browser status light (Client→Host RPC, no home-level plugin needed).

1. In a DSH session with Cordis capabilities loaded, define the plugin with `cordis_define`:
   - `code.host` = the full contents of [`dynamic/host.js`](../../dynamic/host.js);
   - `code.client` = the full contents of [`dynamic/client.js`](../../dynamic/client.js).
2. Activate the returned `pluginId` / `packageId` with `cordis_run` (`mode: "run"`).
3. The first time the **client half** runs, the DSH GUI raises a one-time approval (single check authorizes the current package; double check authorizes future versions). Once granted, the light appears at the right of the session header.
4. Use `cordis_stop` to disable temporarily; `cordis_undefine` to remove permanently.

> If approval prompts are disabled in the session, the client half is auto-rejected — use the **Option A + Option B** combo instead (fallback dialog and home-level light still work).

---

## Uninstall

- **Preset**: delete the `.agent-presets/codebuddy-first/` directory (it disappears from the next roster read).
- **Home-level status-light plugin**: remove the two rows from `cordis.patch.yml` (HMR unloads it), delete `dsh-home/plugins/codebuddy-indicator/` and the three junctions (`node_modules\codebuddy-indicator`, `profiles\node_modules\codebuddy-indicator`, `profiles\web\node_modules\codebuddy-indicator`).
- **Dynamic plugin**: `cordis_undefine <pluginId>`.
