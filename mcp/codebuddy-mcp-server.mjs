#!/usr/bin/env node
// mcp/codebuddy-mcp-server.mjs — 零依赖 stdio MCP server（宿主适配层）。
//
// 让任意 MCP 宿主（Claude Code / Codex / 任意 MCP 客户端）把本地 codebuddy
// (Tencent CodeBuddy Code) CLI 当作子代理使用：
//   - codebuddy_run / codebuddy_continue：派发任务并返回最终答复；
//   - codebuddy_status：实时观察 codebuddy 正在做什么（当前步骤/最近轨迹/
//     按项目累计用量 runs + tokens —— codebuddy 无套餐额度 API，以 token 计量
//     作替代观察）。
//
// 共享逻辑（解析/判定/状态引擎）在 ../core/codebuddy-core.mjs（单一事实来源，
// 同时供 DSH preset 与 dynamic 形态复用）；本文件只保留 MCP 宿主适配：
// JSON-RPC stdio、codebuddy 命令解析、cwd 白名单护栏、文本渲染。
//
// Usage:
//   node codebuddy-mcp-server.mjs                # stdio MCP server
//   node codebuddy-mcp-server.mjs --check        # self-test (no MCP): lists tools, exits
//
// Register (examples):
//   Claude Code : claude mcp add codebuddy -- node C:\path\to\codebuddy-mcp-server.mjs
//   Codex       : add to ~/.codex/config.toml [mcp_servers.codebuddy]
//                 command = "node"
//                 args    = ["C:\\path\\to\\codebuddy-mcp-server.mjs"]
//
// Security: this server launches codebuddy with --permission-mode bypassPermissions
// (full write access) in the working directory it is given. Restrict the working
// directories by setting CODEBUDDY_MCP_ALLOWED_ROOTS to a ';'- or ','-separated
// list of allowed absolute directories — every call's cwd (including the
// session-derived default) must be inside one of them. Unset = allow all
// (backwards compatible; intended for single-user local setups).

import { spawn } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import { existsSync } from 'node:fs'
import {
  isLimited, parseCodebuddyJson, buildResult, buildArgv, createLineStream, createStatusEngine
} from '../core/codebuddy-core.mjs'

const NAME = 'codebuddy-mcp-server'
const VERSION = '1.1.0'
const PROTOCOL = '2024-11-05'

// Default cwd for codebuddy calls that do not pass one (override: CODEBUDDY_MCP_CWD).
const CWD_FALLBACK = process.env.CODEBUDDY_MCP_CWD || 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'

// ── CLI command resolution ────────────────────────────────────────────────────
// Two backends share the same engine and stream-json protocol:
//   codebuddy (default) — Tencent CodeBuddy Code, coding scenarios.
//   workbuddy           — Tencent WorkBuddy, the office-scenario sibling shipped
//                         inside the WorkBuddy desktop app (same CLI, office
//                         product face: docs/slides, knowledge base, media gen,
//                         WeChat/WeCom replies).
// Prefer node + the bin script (codebuddy is normally NOT on PATH, and its
// .cmd shim cannot be spawned by Node without a shell — CVE-2024-27980); fall
// back to a bare `codebuddy` for PATH/native installs.
function commandFor(backend) {
  const nodeExe = process.execPath || 'node'
  if (backend === 'workbuddy') {
    const wbBin = process.env.WORKBUDDY_BIN || 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
    return [nodeExe, wbBin]
  }
  const envBin = process.env.CODEBUDDY_BIN
  if (envBin && existsSync(envBin)) return [nodeExe, envBin]
  const npmBin = (process.env.APPDATA || 'C:\\Users\\lcl\\AppData\\Roaming') + '\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy'
  if (existsSync(npmBin)) return [nodeExe, npmBin]
  return ['codebuddy']
}

// workbuddy 后端不可用时的明确错误信息（spawn ENOENT 之外的前置检查）。
function backendUnavailable(backend, prefix) {
  if (backend === 'workbuddy' && !existsSync(prefix[1] || '')) {
    return 'WorkBuddy CLI not found at "' + (prefix[1] || '') + '" — install the WorkBuddy desktop app (the CLI ships with it at <install>\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy) or set WORKBUDDY_BIN.'
  }
  return null
}

// ── cwd whitelist guard ──────────────────────────────────────────────────────
// CODEBUDDY_MCP_ALLOWED_ROOTS 白名单（; 或 , 分隔的绝对目录）。设置后，每个
// codebuddy 调用的 cwd（含会话回落得到的 cwd）都必须位于白名单目录内，否则
// 拒绝。未设置 → 放行（默认兼容）。
function pathSep() { return process.platform === 'win32' ? '\\' : '/' }
function cwdBlockedReason(cwd) {
  const raw = process.env.CODEBUDDY_MCP_ALLOWED_ROOTS
  if (!raw || !String(raw).trim()) return null
  const target = resolvePath(String(cwd))
  const roots = String(raw).split(/[;,]+/).map((s) => s.trim()).filter(Boolean)
  if (!roots.length) return null
  const ok = roots.some((r) => {
    try {
      const rp = resolvePath(r)
      return target === rp || target.startsWith(rp.endsWith('/') || rp.endsWith('\\') ? rp : rp + pathSep())
    } catch (e) { return false }
  })
  if (ok) return null
  return 'cwd "' + target + '" is outside CODEBUDDY_MCP_ALLOWED_ROOTS (' + roots.join('; ') + '); this MCP server launches codebuddy with permissions bypassed, so the working directory is restricted to the whitelist. Pass an allowed cwd, or ask the server operator to extend CODEBUDDY_MCP_ALLOWED_ROOTS.'
}

// ── status engine (shared with DSH forms) ────────────────────────────────────
const engine = createStatusEngine(null)

// ── run orchestration ────────────────────────────────────────────────────────
function runCodebuddy(args) {
  return new Promise((resolve) => {
    // 后端路由：显式 args.backend 优先；否则按会话归属（codebuddy/workbuddy
    // 各自维护独立会话存储 ~/.codebuddy 与 ~/.workbuddy），默认 codebuddy。
    // cwd 与 backend 一次解析（会话感知回落）。
    const target = engine.resolveTarget(args, CWD_FALLBACK)
    const backend = (args && (args.backend === 'workbuddy' || args.backend === 'codebuddy')) ? args.backend : (target.backend || 'codebuddy')
    const prefix = commandFor(backend)
    const built = buildArgv(prefix, args, { defaultMode: 'accept-edits' })
    const { argv, timeoutSec } = built
    // codebuddy/workbuddy 会话按项目目录（cwd）归档：续接（--resume/--continue）
    // 未显式给 cwd 时，优先回落到该 session 所在项目的 cwd，否则换个目录会
    // "No conversation found with session ID"。
    let cwd = resolvePath(target.cwd)
    // 安全护栏（见文件头 Security 注释）。
    const blocked = cwdBlockedReason(cwd)
    if (blocked) {
      resolve({ ok: false, status: 'CWD_BLOCKED', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: blocked })
      return
    }
    const unavailable = backendUnavailable(backend, prefix)
    if (unavailable) {
      resolve({ ok: false, status: 'CODEBUDDY_UNAVAILABLE', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: unavailable })
      return
    }
    let child
    try {
      // No shell: argv is passed through verbatim, so prompts with spaces /
      // quotes are safe.
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (e) {
      resolve({ ok: false, status: 'SPAWN_ERROR', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: String(e && e.message || e) })
      return
    }
    engine.begin(cwd)
    let out = '', err = ''
    let killed = false
    const timer = setTimeout(() => { killed = true; try { child.kill() } catch {} }, (timeoutSec + 60) * 1000)
    // 半行安全的实时事件流（跨 chunk 的 NDJSON 行拼接）。
    const stream = createLineStream((ln) => {
      const t = ln.trim()
      if (!t.startsWith('{')) return
      try {
        const obj = JSON.parse(t)
        engine.foldEvent(obj, cwd)
      } catch {}
    })
    child.stdout.on('data', (d) => {
      out += d
      if (out.length > 4_000_000) out = out.slice(-2_000_000)
      stream.pushChunk(d)
    })
    child.stderr.on('data', (d) => { err += d; if (err.length > 1_000_000) err = err.slice(-500_000) })
    // ENOENT 等场景 Node 会先派 'error' 再派 'close'；用 settled 保证
    // p.running 只减一次、Promise 只 resolve 一次（旧版双派发会双减计数）。
    let settled = false
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.flush()
      const msg = backend + ' spawn failed: ' + String(e && e.message || e) + (backend === 'workbuddy' ? ' — the WorkBuddy desktop app must be installed (or set WORKBUDDY_BIN)' : ' — install CodeBuddy Code (npm i -g @tencent-ai/codebuddy-code) or set CODEBUDDY_BIN')
      engine.end({ ok: false, status: 'CODEBUDDY_UNAVAILABLE', backend: backend, stderr: msg }, cwd)
      resolve({ ok: false, status: 'CODEBUDDY_UNAVAILABLE', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: msg })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.flush()
      const outcome = { exitCode: killed ? 124 : code }
      const parsed = parseCodebuddyJson(out)
      let res = buildResult(parsed, outcome, built.mode, err, out, backend)
      if (killed && !res.ok) {
        res.status = 'HUNG_TIMEOUT'
        res.stderr = (res.stderr ? res.stderr + ' ' : '') + '[killed by timeout guard after ' + timeoutSec + 's; if this was a long-running script (build/test) raise timeoutSec]'
      }
      engine.end(res, cwd)
      resolve(res)
    })
  })
}

// ── text rendering (MCP has no fallback dialog: no human answerer) ───────────
function textResult(res) {
  const bk = res.backend || 'codebuddy'
  const limited = !res.ok && isLimited(res)
  const head = bk + ' ' + (res.ok ? 'OK' : 'FAILED') + ' [status=' + res.status + ' mode=' + res.mode +
    (res.sessionId ? ' session=' + res.sessionId : '') +
    (res.totalTokens != null ? ' tokens=' + res.totalTokens : '') +
    (res.durationSeconds != null ? ' ' + res.durationSeconds + 's' : '') + ']'
  let note = ''
  if (limited) note = '\n\n[Note: this looks like a rate-limit / network failure. Do NOT retry ' + bk + ' in a loop; finish the task with your own tools, or ask the user.]'
  let body = res.response || (res.stderr ? '[stderr] ' + res.stderr : '')
  // 观测性：无 result 事件时附带原始 stdout 尾部（诊断挂起/解析失败用）。
  if (!res.ok && res.rawStdout) body = (body ? body + '\n\n' : '') + '[raw stdout tail] ' + res.rawStdout
  return { content: [{ type: 'text', text: head + (body ? '\n\n' + body : '') + note }] }
}

function statusText(filterCwd) {
  const snap = engine.statusSnapshot()
  let projects = snap.projects
  let g = snap
  if (filterCwd) {
    const key = String(filterCwd)
    projects = projects.filter((p) => p.cwd === key)
    const first = projects[0]
    if (first) g = first
  }
  const lines = []
  lines.push('codebuddy status: ' + g.state + (g.running > 0 ? ' (' + g.running + ' running)' : '') + (projects.length > 1 ? ' across ' + projects.length + ' projects' : '') + (g.totalTokens ? ' | Σ ' + g.runs + ' runs · ' + g.totalTokens + ' tokens' : ''))
  if (projects.length) {
    for (const p of projects) {
      const cur = p.current ? (' step ' + p.current.stepIndex + ' → ' + p.current.tool + (p.current.args ? ' ' + JSON.stringify(p.current.args) : '')) : (p.running > 0 ? ' (starting / thinking)' : '')
      const usage = (p.runs ? ' | Σ ' + p.runs + ' runs · ' + (p.totalTokens || 0) + ' tokens' : '')
      const bkTag = (p.lastBackend && p.lastBackend !== 'codebuddy') ? ' [' + p.lastBackend + ']' : ''
      lines.push('· ' + p.name + ' [' + p.state + (p.running > 0 ? ' ×' + p.running : '') + ']' + bkTag + cur + (p.lastStatus ? ' | last=' + p.lastStatus + (p.lastSessionId ? ' ' + p.lastSessionId.slice(0, 8) : '') : '') + usage)
      if (p.trail && p.trail.length) {
        lines.push('    steps:')
        for (const e of p.trail.slice(-3)) {
          const a = e.args ? ' ' + JSON.stringify(e.args) : ''
          lines.push('      [' + e.state + '] step ' + e.stepIndex + ' ' + e.tool + a)
        }
      }
    }
  } else {
    if (g.current) {
      const c = g.current
      lines.push('current: step ' + c.stepIndex + ' → ' + c.tool + (c.args ? ' ' + JSON.stringify(c.args) : ''))
    } else if (g.state === 'running') {
      lines.push('current: (starting / thinking)')
    }
    if (g.trail && g.trail.length) {
      lines.push('recent steps:')
      for (const e of g.trail.slice(-6)) {
        const a = e.args ? ' ' + JSON.stringify(e.args) : ''
        lines.push('  [' + e.state + '] step ' + e.stepIndex + ' ' + e.tool + a)
      }
    }
    if (g.lastStatus) lines.push('last: ' + g.lastStatus + (g.lastSessionId ? ' session=' + g.lastSessionId : '') + (g.lastAt ? ' @ ' + new Date(g.lastAt).toISOString() : ''))
  }
  if (g.updatedAt) lines.push('updatedAt: ' + new Date(g.updatedAt).toISOString())
  return lines.join('\n')
}

// ── tool surface ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'codebuddy_run',
    description: 'Dispatch a coding/build/debug/investigation task to the local codebuddy agent CLI (Tencent CodeBuddy Code) and return its final answer. codebuddy runs fully non-interactively with permissions auto-approved (--permission-mode bypassPermissions, never prompts) and applies edits directly. Prefer it for implementation, multi-file edits, refactors and debugging; use your own tools for quick read-only lookups and final build/test verification. mode=plan runs codebuddy read-only. Optional model/effort/maxTurns select the codebuddy model and caps; timeoutSec (10-3600, default 300) is a server-side hang guard. While it runs, call codebuddy_status to watch what codebuddy is doing live. backend="workbuddy" (Tencent WorkBuddy, same engine, office-scenario product face) routes office tasks: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.' },
        backend: { type: 'string', enum: ['codebuddy', 'workbuddy'], description: 'codebuddy (default) for coding work; workbuddy for office tasks (docs/slides, knowledge base, media generation, WeChat/WeCom replies). Continuing a session routes back to its owning backend automatically.' },
        mode: { type: 'string', enum: ['plan', 'accept-edits'], description: 'plan = no writes; accept-edits = allow edits (default).' },
        model: { type: 'string', description: 'Optional codebuddy model id (hy4-preview, hy3, hy3-x, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.7, kimi-k2.6, deepseek-v4-pro, deepseek-v4-flash). Unset = codebuddy configured default.' },
        effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' },
        maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500, default unlimited).' },
        cwd: { type: 'string', description: 'Working directory for codebuddy (default: CODEBUDDY_MCP_CWD or the fallback workspace). If the server sets CODEBUDDY_MCP_ALLOWED_ROOTS, this must be inside the whitelist.' },
        addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to the codebuddy workspace.' },
        timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); the server force-kills at timeout+60s.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'codebuddy_continue',
    description: 'Continue an existing codebuddy conversation with a follow-up prompt, reusing codebuddy context. Pass sessionId from a prior codebuddy_run result, or latest=true for the most recent conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codebuddy conversation.' },
        sessionId: { type: 'string', description: 'codebuddy session id to resume (from a prior codebuddy_run result).' },
        latest: { type: 'boolean', description: 'Continue the most recent codebuddy conversation.' },
        backend: { type: 'string', enum: ['codebuddy', 'workbuddy'], description: 'Which CLI to resume on; defaults to the backend owning the sessionId.' },
        mode: { type: 'string', enum: ['plan', 'accept-edits'], description: 'plan = no writes; accept-edits = allow edits (default).' },
        model: { type: 'string', description: 'Optional codebuddy model id.' },
        effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
        maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500).' },
        cwd: { type: 'string', description: "Working directory for codebuddy; when resuming, defaults to the resumed session's project directory." },
        timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300).' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'codebuddy_status',
    description: 'Read a live snapshot of what the local codebuddy agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or thinking/typing), the recent step trail (tools executed, done/error), the last completed run status + session id, and per-project cumulative usage (runs + total tokens, since codebuddy exposes no quota API). Optional cwd filters to a single project. Call this to check on an in-flight codebuddy_run/codebuddy_continue without waiting for it to finish.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }
  }
]

async function callTool(name, args) {
  if (name === 'codebuddy_status') {
    const a = args || {}
    return { content: [{ type: 'text', text: statusText(a.cwd) }] }
  }
  const a = args || {}
  if (!a.prompt || !String(a.prompt).trim()) {
    return { content: [{ type: 'text', text: 'codebuddy error: prompt is required' }], isError: true }
  }
  const mapped = { ...a }
  if (name === 'codebuddy_continue' && !mapped.sessionId && mapped.latest) mapped.continueLatest = true
  // MCP has no human answerer, so there is no fallback dialog here: a failed
  // run returns its error text (annotated when it looks rate-limited) and the
  // calling agent decides what to do.
  const res = await runCodebuddy(mapped)
  const out = textResult(res)
  if (!res.ok) out.isError = false
  return out
}

// ── minimal JSON-RPC / MCP stdio plumbing ────────────────────────────────────
let buf = ''
function writeMsg(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
function handleLine(line) {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  const isReq = id !== undefined && id !== null
  const reply = (result) => writeMsg({ jsonrpc: '2.0', id, result })
  const replyErr = (code, message) => writeMsg({ jsonrpc: '2.0', id, error: { code, message } })

  if (method === 'initialize') {
    reply({
      protocolVersion: (params && params.protocolVersion) || PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION }
    })
    return
  }
  if (method === 'notifications/initialized' || (method || '').startsWith('notifications/')) return
  if (method === 'ping') { reply({}); return }
  if (method === 'tools/list') { reply({ tools: TOOLS }); return }
  if (method === 'tools/call') {
    const name = params && params.name
    if (!TOOLS.some((t) => t.name === name)) { replyErr(-32602, 'Unknown tool: ' + name); return }
    pendingCalls++
    callTool(name, params && params.arguments)
      .then(reply, (e) => replyErr(-32603, String(e && e.message || e)))
      .finally(() => { pendingCalls--; maybeExit() })
    return
  }
  if (method === 'resources/list') { reply({ resources: [] }); return }
  if (method === 'prompts/list') { reply({ prompts: [] }); return }
  if (isReq) replyErr(-32601, 'Method not found: ' + method)
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    try { handleLine(line) } catch (e) { /* keep server alive */ }
  }
})
// Track in-flight tool calls so stdin EOF does not kill pending work: MCP
// clients keep the pipe open, but a CLI probe may close stdin after writing
// its lines while a long codebuddy run is still in flight. Only exit when the
// transport is gone AND no tool call is pending.
let pendingCalls = 0
let stdinClosed = false
function maybeExit() { if (stdinClosed && pendingCalls === 0) process.exit(0) }
process.stdin.on('end', () => { stdinClosed = true; maybeExit() })
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// --check self-test: verify tool schema surface, no MCP handshake.
if (process.argv.includes('--check')) {
  const valid = TOOLS.every((t) => t.name && t.inputSchema && t.inputSchema.type === 'object')
  console.log(JSON.stringify({ ok: valid, server: NAME, version: VERSION, tools: TOOLS.map((t) => t.name) }, null, 2))
  process.exit(valid ? 0 : 1)
}
