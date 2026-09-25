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
import { resolve as resolvePath, dirname, join as joinPath } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isLimited, isTransientCliError, failureHint, parseCodebuddyJson, buildResult, buildArgv, createLineStream, createStatusEngine,
  buildMcpBridgePayload, MCP_BRIDGE_FILE,
  BACKENDS, DEFAULT_BACKEND, resolveBackend, endpointEnv, endpointMismatchHint,
  BACKEND_AUTH_IDS, resolveEnToken, readBridgeSettingsFile, defaultBridgeSettings
} from '../core/codebuddy-core.mjs'

const NAME = 'codebuddy-mcp-server'
const VERSION = '1.6.2'
const PROTOCOL = '2024-11-05'

// Default cwd for codebuddy calls that do not pass one (override: CODEBUDDY_MCP_CWD).
const CWD_FALLBACK = process.env.CODEBUDDY_MCP_CWD || 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'

// ── user settings (v1.3.2, shared with the visual config panel) ─────────────
// dsh-home 根目录的 codebuddy-bridge-settings.json：{"preferredBackend": "...",
// "defaultModel": "...", "codebuddyEnToken": "...", "endpointOverride": "..."}。
// 唯一写者是设置面板（indicator 的 POST /codebuddy-indicator/settings）；
// preset / dynamic / MCP 三形态读同一份、同一实现（core.readBridgeSettingsFile）。
// MCP 子进程定位 dsh-home 的优先级：CODEBUDDY_INDICATOR_DIR > DSH_HOME >
// bin 的父目录（部署形态 <dsh-home>/bin/codebuddy-mcp-server.mjs）。
function mcpSettingsPath() {
  const explicit = process.env.CODEBUDDY_INDICATOR_DIR || process.env.DSH_HOME
  if (explicit) return joinPath(explicit, 'codebuddy-bridge-settings.json')
  try {
    const selfDir = dirname(fileURLToPath(import.meta.url))
    if (/[\\/]bin$/.test(selfDir)) return joinPath(dirname(selfDir), 'codebuddy-bridge-settings.json')
  } catch (e) { }
  return null
}
const SETTINGS_PATH = mcpSettingsPath()
const SETTINGS_DEFAULTS = defaultBridgeSettings()
let settingsCache = { at: 0, value: null }
function readSettings() {
  // 5s 缓存：同一批并发调用不重复读盘，改动也足够快生效。
  const now = Date.now()
  if (settingsCache.value && now - settingsCache.at < 5000) return settingsCache.value
  const snap = readBridgeSettingsFile({ path: SETTINGS_PATH }) || SETTINGS_DEFAULTS
  settingsCache = { at: now, value: snap }
  return snap
}

// 登录域读取（v1.3.1）：端点必须与登录域一致，否则 CLI 报 401（npm CLI 的 token 域
// 是 www.codebuddy.cn，product 端点却是 www.codebuddy.ai → 必然 401）。auth 库的
// auth.domain 是明文，无需解密 token 即可对齐端点。失败返回 null（退化为沿用
// CLI 自身 product 端点）。
function readAuthDomain(backend) {
  const id = BACKEND_AUTH_IDS[backend]
  if (!id) return null
  try {
    // CODEBUDDY_AUTH_DIR 可覆盖（测试夹具目录，使用例与真机登录状态解耦）。
    const dir = process.env.CODEBUDDY_AUTH_DIR || joinPath(
      process.env.LOCALAPPDATA || 'C:\\Users\\lcl\\AppData\\Local',
      'CodeBuddyExtension', 'Data', 'Public', 'auth')
    const p = joinPath(dir, id + '.info')
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    const d = raw && raw.auth && raw.auth.domain
    return typeof d === 'string' && d.trim() ? d.trim() : null
  } catch (e) { return null }
}

// ── CLI command resolution ────────────────────────────────────────────────────
// Three backends, three DISTINCT installs (v1.3.0's "international edition reuses
// the same npm CLI" claim was disproven on the real machine — each product has its
// own product.json identity; see docs/ROOT-CAUSE-codebuddy-en.md):
//   codebuddy (default) — domestic CodeBuddy npm package (@tencent-ai/codebuddy-code,
//                         productName "CodeBuddy", product endpoint www.codebuddy.ai).
//   codebuddy-en        — WorkBuddy AI international desktop bundled CLI
//                         (productName "WorkBuddy AI", endpoint www.workbuddy.ai).
//   workbuddy           — WorkBuddy domestic desktop bundled CLI
//                         (productName "WorkBuddy", endpoint copilot.tencent.com).
// All three share the engine and stream-json protocol.
// Prefer node + the bin script (codebuddy is normally NOT on PATH, and its
// .cmd shim cannot be spawned by Node without a shell — CVE-2024-27980); fall
// back to a bare `codebuddy` for PATH/native installs.
function commandFor(backend) {
  const nodeExe = process.execPath || 'node'
  if (backend === 'workbuddy') {
    const wbBin = process.env.WORKBUDDY_BIN || 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
    return [nodeExe, wbBin]
  }
  if (backend === 'codebuddy-en') {
    const enBin = process.env.CODEBUDDY_EN_BIN || 'C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
    return [nodeExe, enBin]
  }
  const envBin = process.env.CODEBUDDY_BIN
  if (envBin && existsSync(envBin)) return [nodeExe, envBin]
  const npmBin = (process.env.APPDATA || 'C:\\Users\\lcl\\AppData\\Roaming') + '\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy'
  if (existsSync(npmBin)) return [nodeExe, npmBin]
  return ['codebuddy']
}

// 后端不可用时的明确错误信息（spawn ENOENT 之外的前置检查）。
function backendUnavailable(backend, prefix) {
  if (backend === 'workbuddy' && !existsSync(prefix[1] || '')) {
    return 'WorkBuddy CLI not found at "' + (prefix[1] || '') + '" — install the WorkBuddy desktop app (the CLI ships with it at <install>\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy) or set WORKBUDDY_BIN.'
  }
  if (backend === 'codebuddy-en' && !existsSync(prefix[1] || '')) {
    return 'WorkBuddy AI (international) CLI not found at "' + (prefix[1] || '') + '" — install the WorkBuddy AI desktop app (the CLI ships with it at <install>\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy) or set CODEBUDDY_EN_BIN.'
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
//
// 状态灯通道（v1.1.5）：本进程是独立子进程，没有 ctx.emit、也拿不到家级插件的
// codebuddyCollector 服务，所以把每次状态变化原子写入 dsh-home 下的快照文件，由
// 家级插件在响应 /codebuddy-indicator/status 时读取合并。此前 publish 传 null，
// 标准模式（走全局 MCP 行）的运行过程对状态灯完全不可见。
//
// dsh-home 定位顺序：显式环境变量 → 部署位置（dsh-home/bin/ 的上一级）→ 关闭通道。
// 仓库内直接运行（mcp/ 目录）不写文件，避免往仓库里落状态。
function resolveBridgePath() {
  const explicit = process.env.CODEBUDDY_INDICATOR_DIR || process.env.DSH_HOME
  if (explicit) return joinPath(explicit, MCP_BRIDGE_FILE)
  try {
    const selfDir = dirname(fileURLToPath(import.meta.url))
    // 部署形态：<dsh-home>/bin/codebuddy-mcp-server.mjs
    if (/[\\/]bin$/.test(selfDir)) return joinPath(dirname(selfDir), MCP_BRIDGE_FILE)
  } catch (e) { }
  return null
}

const BRIDGE_PATH = resolveBridgePath()

// 原子写：先写临时文件再 rename，避免家级插件读到半截 JSON。
// 任何失败都静默忽略——状态灯是附加信息，绝不能影响工具本身。
function publishSnapshot(snap) {
  if (!BRIDGE_PATH) return
  try {
    const payload = buildMcpBridgePayload(snap, process.pid, Date.now())
    const tmp = BRIDGE_PATH + '.' + process.pid + '.tmp'
    try { mkdirSync(dirname(BRIDGE_PATH), { recursive: true }) } catch (e) { }
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, BRIDGE_PATH)
  } catch (e) { }
}

const engine = createStatusEngine({ publish: publishSnapshot })

// ── run orchestration ────────────────────────────────────────────────────────
function runCodebuddy(args) {
  return new Promise((resolve) => {
    // 后端路由（v1.3.0）：显式 args.backend 优先；否则按会话归属（各后端登录域
    // 互斥），再落到用户偏好 preferredBackend（设置文件），最后默认 codebuddy。
    // cwd 与 backend 一次解析（会话感知回落）。
    const settings = readSettings()
    const target = engine.resolveTarget(args, CWD_FALLBACK)
    const backend = resolveBackend(args, target, settings.preferredBackend)
    // 端点/凭据（v1.3.1）：端点按登录域自动对齐（修 codebuddy 的 401）；凭据仅
    // codebuddy-en 需要（其 token 被桌面 App 的 protector key 封装，headless 读不到）。
    const authDomain = readAuthDomain(backend)
    // 凭据三通道（v1.3.1）：设置文件 > CODEBUDDY_AUTH_TOKEN 环境变量 > DSH 凭据库
    // （.credentials.yaml / .env 里指向 workbuddy.ai/v2 的 WORKBUDDY_TOKEN）。
    const enTok = backend === 'codebuddy-en' ? resolveEnToken(settings.codebuddyEnToken) : { token: null }
    const authToken = enTok.token
    if (backend === 'codebuddy-en' && !authToken) {
      resolve({
        ok: false, status: 'AUTH_REQUIRED', response: '', sessionId: null, durationSeconds: null,
        numTurns: null, totalTokens: null, exitCode: null, mode: 'accept-edits', backend: backend,
        stderr: endpointMismatchHint(backend, authDomain, false)
      })
      return
    }
    const prefix = commandFor(backend)
    const built = buildArgv(prefix, args, {
      defaultMode: 'accept-edits',
      defaultModel: (args && args.model) ? null : settings.defaultModel,
      env: endpointEnv(backend, settings.endpointOverride, authDomain, authToken)
    })
    const { argv, timeoutSec } = built
    // 端点覆盖/凭据注入（CODEBUDDY_BASE_URL / CODEBUDDY_AUTH_TOKEN）。
    const spawnEnv = (built.env && typeof built.env === 'object') ? { ...process.env, ...built.env } : undefined
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
      // quotes are safe. spawnEnv is only set for codebuddy-en (endpoint env).
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        ...(spawnEnv ? { env: spawnEnv } : {}),
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
    // stdout 必须声明 utf8 编码：不声明时 'data' 派发的是 Buffer，而
    // createLineStream.pushChunk 只接受字符串（非字符串静默 return）——于是
    // foldEvent 从不触发，状态灯拿不到 current/trail（活动明细全空）。
    // 用 setEncoding 而非 String(d)：后者会在多字节 UTF-8 字符跨 chunk 边界时
    // 产生乱码，setEncoding 由 Node 的 StringDecoder 正确处理半个字符。
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
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
    (res.modelUsed ? ' model=' + res.modelUsed : '') +
    (res.retried ? ' retried=1' : '') +
    (res.sessionId ? ' session=' + res.sessionId : '') +
    (res.totalTokens != null ? ' tokens=' + res.totalTokens : '') +
    (res.durationSeconds != null ? ' ' + res.durationSeconds + 's' : '') + ']'
  let note = ''
  if (limited) note = '\n\n[Note: this looks like a rate-limit / network failure. Do NOT retry ' + bk + ' in a loop; finish the task with your own tools, or ask the user.]'
  let body = res.response || (res.stderr ? '[stderr] ' + res.stderr : '')
  // 观测性：无 result 事件时附带原始 stdout 尾部（诊断挂起/解析失败用）。
  if (!res.ok && res.rawStdout) body = (body ? body + '\n\n' : '') + '[raw stdout tail] ' + res.rawStdout
  // 失败时给出可行动指引（此前失败只有一行 head，模型无从判断下一步）。
  const hint = failureHint(res)
  if (hint) body = (body ? body + '\n\n' : '') + hint
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
  lines.push('codebuddy status: ' + g.state + (g.running > 0 ? ' (' + g.running + ' running)' : '') + (projects.length > 1 ? ' across ' + projects.length + ' projects' : '') + (g.totalTokens ? ' | total ' + g.runs + ' runs, ' + g.totalTokens + ' tokens' : ''))
  if (projects.length) {
    for (const p of projects) {
      const cur = p.current ? (' step ' + p.current.stepIndex + ' → ' + p.current.tool + (p.current.args ? ' ' + JSON.stringify(p.current.args) : '')) : (p.running > 0 ? ' (starting / thinking)' : '')
      const usage = (p.runs ? ' | total ' + p.runs + ' runs, ' + (p.totalTokens || 0) + ' tokens' : '')
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
    description: 'Dispatch a coding/build/debug/investigation task to the local codebuddy agent CLI (Tencent CodeBuddy Code) and return its final answer. codebuddy runs fully non-interactively with permissions auto-approved (--permission-mode bypassPermissions, never prompts) and applies edits directly. Prefer it for implementation, multi-file edits, refactors and debugging; use your own tools for quick read-only lookups and final build/test verification. mode=plan runs codebuddy read-only. Optional model/effort/maxTurns select the codebuddy model and caps; timeoutSec (10-3600, default 300) is a server-side hang guard. While it runs, call codebuddy_status to watch what codebuddy is doing live. backend="codebuddy-intl" (the INTERNATIONAL face of the same npm CLI — product.ioa.json catalogue: claude-sonnet-5 / claude-opus-5 / gemini-3.1-pro / gpt-6-astra / hy3-ioa; aliases codebuddy-ioa / codebuddy-international accepted), backend="codebuddy-en" (WorkBuddy international edition — the WorkBuddyAI desktop bundled CLI; aliases workbuddy-en / workbuddy-ai accepted) and backend="workbuddy" (WorkBuddy domestic desktop bundled CLI; office-scenario product face: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies) route to the other product faces.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.' },
        backend: { type: 'string', enum: ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy'], description: 'codebuddy (default) for coding work (domestic CodeBuddy npm CLI); codebuddy-intl = the INTERNATIONAL face of that same npm CLI (product.ioa.json catalogue: claude-sonnet-5 / claude-opus-5 / gemini-3.1-pro / gpt-6-astra / hy3-ioa; aliases codebuddy-ioa / codebuddy-international) — use it for international CodeBuddy accounts; codebuddy-en = WorkBuddy international edition (the WorkBuddyAI desktop CLI at C:\\Program Files\\WorkBuddyAI; aliases workbuddy-en / workbuddy-ai accepted; needs codebuddyEnToken in the settings file unless DSH already holds a workbuddy key — its login token is sealed by a protector key the headless CLI cannot read); workbuddy for the WorkBuddy domestic desktop CLI, also the office-scenario face (docs/slides, knowledge base, media generation, WeChat/WeCom replies). New calls without a backend follow the user-preferred default backend (settings file). Continuing a session routes back to its owning backend automatically.' },
        mode: { type: 'string', enum: ['plan', 'accept-edits'], description: 'plan = no writes; accept-edits = allow edits (default).' },
        model: { type: 'string', description: 'Optional model id. When unspecified, the user-preferred default model (plugin settings) is used if set, else the CLI default. Two layers decide: the PRODUCT FACE decides whether the id exists in its catalogue, then the ACCOUNT decides whether it is licensed. The free tier (hy3, deepseek-v4.1-flash at x0.00 credits; hy4-preview at x0.29) belongs to the npm CLI faces codebuddy/codebuddy-intl: hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, deepseek-v4-pro. codebuddy-en (WorkBuddyAI) carries NO hy4-preview and NO deepseek-v4.1-flash; its only free model is hy3. International ids (claude-sonnet-5, gemini-3.1-pro, ...) are account-gated. Availability is per ACCOUNT: the CLI rejects an id outside the account catalogue with "400 service info not found" and one inside it but unlicensed with "400 only available for authorized users" (many catalogue flagships such as claude-opus-4.8, gpt-5.4 and gpt-6-astra are in this second group for a domestic account). Run the CLI with a deliberately invalid model id to print "Currently supported models for your account:" and get the authoritative list; the plugin caches that result and the settings panel lists exactly those ids with their credit multiplier (x0.00 = free), read live from the CLI descriptor so it stays in sync with CLI upgrades. Prefer the cheapest model that can do the job, and prefer a free (x0.00) one for routine work. Pass a model only when the task clearly benefits from a specific one.' },
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
        backend: { type: 'string', enum: ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy'], description: 'Which CLI face to resume on (codebuddy-en = WorkBuddy international, aliases workbuddy-en / workbuddy-ai accepted); defaults to the backend owning the sessionId, then the user-preferred default backend (settings file).' },
        mode: { type: 'string', enum: ['plan', 'accept-edits'], description: 'plan = no writes; accept-edits = allow edits (default).' },
        model: { type: 'string', description: 'Optional model id (two layers: product face carries it, account licenses it; the credit multiplier of each id comes from the CLI descriptor — see codebuddy_run).' },
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
  let res = await runCodebuddy(mapped)
  // CLI 侧瞬时错误（error_during_execution，CLI 不给原因）：静默自动重试一次。
  // MCP 侧没有弹窗可问人，而实测同一请求重跑即过；不重试的话调用方只会拿到一行
  // 无原因失败，白耗一次 status 再靠猜换模型（实测就是这么发生的）。
  // 续接类调用（--resume/--continue）不自动重试：会话状态可能已被前一次改动。
  if (isTransientCliError(res) && !mapped.sessionId && !mapped.continueLatest) {
    const retry = await runCodebuddy(mapped)
    if (retry.ok) res = retry
    else { res = retry; res.retried = true }
  }
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