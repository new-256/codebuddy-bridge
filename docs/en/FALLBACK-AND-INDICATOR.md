# Fallback mechanism & status light

[简体中文](../FALLBACK-AND-INDICATOR.md)

This document describes the two requested capabilities: the **fallback dialog when codebuddy is limited**, and the **live status light**.

---

## 1. Fallback mechanism (confirmation dialog)

### Trigger

After each `codebuddy_run` / `codebuddy_continue` execution, if the result has `ok === false` and is judged "likely rate-limited / network down", the fallback dialog is triggered. `isLimited(res)` matches when any of the following holds:

- `status` is `SPAWN_ERROR` or `CODEBUDDY_UNAVAILABLE` (process could not start / codebuddy not found);
- the concatenation of `stderr` + `response` + `status` matches this regex (case-insensitive):

  ```
  rate limit / ratelimit / 429 / too many / quota / exceed /
  network / offline / ENETUNREACH / ECONNREFUSED / ECONNRESET /
  ETIMEDOUT / EAI_AGAIN / ENOTFOUND / timeout / timed out /
  unavailable / 503 / 502 / 500 / connection / proxy / socket /
  tls / ssl / dns / 网络 / 超时 / 限流 / 流量 / 受限 / 配额 / 连接 / 断开
  ```

### Dialog

A single-choice question is raised through DSH's `userQuestions.ask()`:

> **codebuddy 受限** — codebuddy call failed (likely rate-limited/network down, status=`<status>`). Switch to the DSH local API config and continue?

Three options:

| Option | Behaviour |
| --- | --- |
| **使用 DSH 本地 API 配置（回退）** (use DSH local API config / fall back) | Returns `{ ok:false, fallback:true, status:'FALLBACK_TO_DSH', reason:<original status> }`. The model then completes the task with **native tools / the local model** and does not call codebuddy again. |
| **重试 codebuddy 一次** (retry codebuddy once) | Immediately runs codebuddy once more (up to 2 attempts total). |
| **不回退（返回错误）** (do not fall back) | Returns the codebuddy error as-is; the model decides what to do next. |

### Anti-block / anti-loop design

- **No dialog when there is no live human answerer.** `userQuestions.ask()` is valid only for the exact live runtime root. If the call comes from a delegated subagent (`exec.agent` is not the live root, or is owned by another agent), `ask()` throws `CALLER_NOT_LIVE` / `DELEGATED_CALLER`; the plugin catches it and treats it as `'error'` (no dialog, return the error), so a subagent never blocks forever. The same applies when the `userQuestions` service is absent.
- **At most 2 attempts.** The main loop stops at `attempt >= 2`, preventing repeated retries.
- **Background jobs do not prompt.** A `background:true` task runs asynchronously through `jobs`, and a human context may no longer be present at completion, so background failures do **not** open the dialog — the tool's return note also says "re-run in the foreground to be prompted".
- **codebuddy never calls back into DSH.** The policy prompt explicitly forbids codebuddy from calling back into DSH, avoiding loops.

### Model-side contract (prompt section)

The injected `codebuddy:policy` section includes this contract so the model consumes the fallback result correctly:

> When codebuddy is rate-limited or the network is down, codebuddy_run/codebuddy_continue automatically pop a dialog asking whether to use the DSH local API config. If the result has `fallback=true` (`status FALLBACK_TO_DSH`), the user chose to fall back: complete the task with native DSH tools / the local model and do **not** call codebuddy again. If `ok=false` without `fallback`, report the codebuddy error. Never loop codebuddy calls; never ask codebuddy to call back into DSH.

### Sequence

```
codebuddy_run
  └─ runSync ──▶ result res
       ├─ res.ok?                         ──▶ return success
       ├─ !isLimited(res)?                ──▶ return error as-is
       └─ isLimited(res):
            askFallback(exec, res)
              ├─ no live human answerer   ──▶ return error
              ├─ "fall back"              ──▶ return { fallback:true, FALLBACK_TO_DSH }
              ├─ "retry" and attempt<2    ──▶ run once more
              └─ "do not fall back"       ──▶ return error as-is
```

---

## 2. Live status light (dynamic form + home-level plugin; start-up persistent)

### Location and appearance

The light is registered in the Slot `conversation.session.header.utilities` on the right of the browser session header (home-level light id: `codebuddy-indicator-home`). It is a small pill of "coloured dot + label"; hovering shows `state / running / last / session` detail.

| `state` | Dot colour (theme token) | Label |
| --- | --- | --- |
| `running` | static blue `--dsw-static-blue-500` (#3b82f6, pulsing; brand-primary resolves near-black and is not used) | `CB 工作中` (shows `×N` when several run concurrently) |
| `ok` | static green `--dsw-static-green-500` (#22c55e) | `CB` |
| `failed` | error `--dsw-alias-state-error-primary` | `CB 失败` |
| `fallback` | warning `--dsw-alias-state-warn-primary` | `本地回退` |
| `idle` | secondary label `--dsw-alias-label-secondary` | `CB 就绪` |

All colours come from DSH theme tokens, so the light adapts to light/dark automatically.

### Data source (two channels)

**Channel one (dynamic form → home-level collector):** the dynamic sandbox has no `ctx.emit`, so the host half pushes state through the `codebuddyCollector` service provided by the home-level plugin (`ctx.provide`), into the same global project table rendered by the home-level light. The host also keeps the read-only `harness.handle('codebuddy_status', () => snapshot())` RPC as a package-private query channel — the snapshot carries only scalar fields, no references to host live objects.

**Channel two (preset form, event push + HTTP):** the preset form (real Node module) emits `ctx.emit('codebuddy/status', { snapshot })` after every `begin` / `end` / `foldEvent`; the home-level `codebuddy-indicator` host half collects it with `ctx.on('codebuddy/status')`, merges by cwd into a global project table, and exposes `GET /codebuddy-indicator/status` via `webServer`; the home-level client half polls that route every 1.2s and renders the same per-project lights. It **starts with the software, appears in every session, and needs no approval**.

### One-time approval (dynamic form only)

The first time the client half of the **dynamic form** runs, the DSH GUI requests approval (Cordis's single/double-check grant mechanism). Once granted, the light appears. If the session disables approval prompts, the client half is auto-rejected — the fallback dialog still works, just without the dynamic light (the **home-level light is unaffected**).

### Why the preset form itself has no status light

A preset is a host-plane composition whose `.mjs` runs only on the Node side and carries no browser UI; browser UI must come from a client-plane component. **The home-level plugin (`home-plugin/codebuddy-indicator/`, registered via `cordis.patch.yml`) fills this gap**: it brings its own host half (event collector + HTTP route) and client half (browser light), and the preset only needs to emit `ctx.emit('codebuddy/status')` on state changes — no separate client bundle or `pnpm run dev:web` rebuild required. The fallback dialog is a host capability and is present in both the preset and dynamic forms.
