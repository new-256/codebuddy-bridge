// dynamic/host.js — 【生成文件，勿手改】
// 由 scripts/build.mjs 从本模板（dynamic/host.template.mjs）+
// core/codebuddy-core.mjs 拼装生成。修改共享逻辑 → 改 core；修改动态适配 →
// 改本模板；然后 `node scripts/build.mjs` 重新生成并提交。
//
// Cordis 动态插件沙箱禁止 import/require，故共享核心以文本注入到本文件中
// 段的 CORE 占位标记处（见下方独立一行的标记）。
// 沙箱内无 process/env/ctx.emit：node 可执行文件经 subprocess.resolveExecutable
// 解析，状态经家级收集器（codebuddyCollector.mergeSnapshot）汇入状态灯。
// core/codebuddy-core.mjs — 共享核心（单一事实来源）。
//
// 三种交付形态（preset / dynamic / MCP）都从本文件派生：
//   - MCP server 直接 import 本模块（仓库内运行）；
//   - preset 通过 scripts/build.mjs 生成的同目录副本（'./codebuddy-core.mjs'）
//     导入 —— 安装到 .agent-presets/codebuddy-first/ 的目录因此自包含；
//   - dynamic/host.js 由 scripts/build.mjs 从本文件文本生成（Cordis 动态插件
//     沙箱禁止 import，故用生成 + 同步测试锁住一致性）。
// 约束：本文件不使用 process / env / fs（preset 与 dynamic 沙箱内不可用）；
// 不使用 import（生成器只剥离开头的 export 关键字）。
//
// 纯函数 + 状态引擎 + 执行编排均为零依赖纯 JS（Node >= 18）。

// ── 常量 ──────────────────────────────────────────────────────────────────────

// 限流/网络/认证失败判定。仅匹配 stderr + status（不匹配回复全文——排查网络类
// 任务的答复里几乎必然出现 connection/dns/timeout 字样，会误判成限流）；数字码
// 加词边界（避免 "1500" 命中 500、"4013" 命中 401）。
const LIMIT_RE = /rate.?limit|ratelimit|\b429\b|too many|quota|insufficient|credit|balance|exhausted|exceed|\bnetwork\b|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|\btimeouts?\b|timed out|unavailable|\b50[023]\b|\b40[13]\b|unauthorized|invalid api|api key|proxy|socket|tls|ssl|\bdns\b|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开/i

const MAX_TRAIL = 12
const MAX_ARG_LEN = 120
const MAX_PROJECTS = 12

// ── 纯函数 ────────────────────────────────────────────────────────────────────

function isLimited(res) {
  if (!res || res.ok) return false
  if (res.status === 'SPAWN_ERROR' || res.status === 'CODEBUDDY_UNAVAILABLE' || res.status === 'HUNG_TIMEOUT') return true
  const hay = String(res.stderr || '') + ' ' + String(res.status || '')
  return LIMIT_RE.test(hay)
}

function clampInt(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

function shortLabel(prompt) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim()
  return s.length > 80 ? s.slice(0, 77) + '...' : s
}

// 工具入参摘要（用于状态灯/活动面板）。返回值必须是可无损 JSON 化的数据：
// undefined 值直接跳过（DSH tool 渲染层不接受 undefined）。
function summarizeArgs(parameters) {
  if (!parameters || typeof parameters !== 'object') return null
  const out = {}
  for (const k of Object.keys(parameters)) {
    let v = parameters[k]
    if (v === undefined) continue
    if (typeof v === 'string' && v.length > MAX_ARG_LEN) v = v.slice(0, MAX_ARG_LEN) + '…'
    out[k] = v
  }
  return out
}

// 从 codebuddy stream-json 输出里解析最终 result 事件（自后向前找第一行
// type==='result' 的完整 JSON 行；整体 JSON 兜底）。
function parseCodebuddyJson(stdoutText) {
  const trimmed = String(stdoutText || '').trim()
  if (!trimmed) return null
  const lines = trimmed.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim()
    if (!ln.startsWith('{')) continue
    try {
      const obj = JSON.parse(ln)
      if (obj && obj.type === 'result') return obj
    } catch (e) {}
  }
  try { return JSON.parse(trimmed) } catch (e) {}
  return null
}

// result 事件 → 统一结果对象（ok/status/response/sessionId/tokens/…）。
function buildResult(parsed, outcome, mode, stderrText, stdoutText) {
  const exitCode = outcome ? outcome.exitCode : null
  const errText = parsed && typeof parsed.error === 'string' && parsed.error ? parsed.error : ''
  const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
  if (parsed && parsed.type === 'result') {
    const isOk = exitCode === 0 && parsed.is_error === false && parsed.subtype === 'success'
    return {
      ok: isOk,
      status: String(parsed.subtype || (isOk ? 'SUCCESS' : 'ERROR')).toUpperCase(),
      response: typeof parsed.result === 'string' ? parsed.result : '',
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      durationSeconds: typeof parsed.duration_ms === 'number' ? parsed.duration_ms / 1000 : null,
      numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
      totalTokens: (parsed.usage && typeof parsed.usage.input_tokens === 'number' && typeof parsed.usage.output_tokens === 'number')
        ? (parsed.usage.input_tokens + parsed.usage.output_tokens) : null,
      exitCode: exitCode,
      mode: mode,
      stderr: stderr
    }
  }
  return {
    ok: false,
    status: 'PARSE_ERROR',
    response: '',
    sessionId: null,
    durationSeconds: null,
    numTurns: null,
    totalTokens: null,
    exitCode: exitCode,
    mode: mode,
    stderr: stderr,
    rawStdout: String(stdoutText || '').slice(-2000)
  }
}

// 统一 argv 构造。prefix 是命令头数组（['codebuddy'] 或 ['node', <bin>]）。
// mode 解析：'auto' → 由 planActive 决定 plan/bypassPermissions（DSH preset）；
// 'plan' → 只读；其余（'accept-edits' 等）→ bypassPermissions（MCP 默认）。
// 返回 { argv, timeoutSec, mode }（mode 为解析后的规范值）。
function buildArgv(prefix, args, opts) {
  const o = opts || {}
  const argv = [prefix[0], ...prefix.slice(1), '-p', String(args.prompt), '--output-format', 'stream-json']
  let mode = args.mode || o.defaultMode || 'auto'
  if (mode === 'auto') mode = o.planActive ? 'plan' : 'bypassPermissions'
  if (mode === 'plan') {
    argv.push('--permission-mode', 'plan')
  } else {
    mode = 'bypassPermissions'
    argv.push('--permission-mode', 'bypassPermissions')
  }
  if (args.model) argv.push('--model', String(args.model))
  if (args.effort) argv.push('--effort', String(args.effort))
  if (args.maxTurns !== undefined && args.maxTurns !== null) argv.push('--max-turns', String(clampInt(args.maxTurns, 50, 1, 500)))
  if (Array.isArray(args.addDirs)) for (const d of args.addDirs) { if (d) argv.push('--add-dir', String(d)) }
  if (args.sessionId) argv.push('--resume', String(args.sessionId))
  else if (args.continueLatest) argv.push('--continue')
  const timeoutSec = clampInt(args.timeoutSec, 300, 10, 3600)
  return { argv, timeoutSec, mode }
}

// 回退结果（用户在弹窗选择「使用 DSH 本地 API 配置」后返回给调用方的标记）。
function fallbackResult(res, mode) {
  return { ok: false, fallback: true, status: 'FALLBACK_TO_DSH', response: '', sessionId: (res && res.sessionId) || null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: res ? res.exitCode : null, mode: mode, stderr: res ? res.stderr : '', reason: res ? res.status : 'unknown' }
}

function projectName(cwd) {
  const s = String(cwd || '')
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : s
}

// ── 半行安全的行流（跨 chunk 的 NDJSON 行拼接）───────────────────────────────
// stdout chunk 可能在行中间截断；只处理到最后一个换行，剩余半行留到下一轮
// 拼接（否则跨 chunk 的行会被 JSON.parse 失败后永久丢弃）。
function createLineStream(consumeLine) {
  let pending = ''
  function pushChunk(text) {
    if (typeof text !== 'string' || !text) return
    const lines = (pending + text).split(/\r?\n/)
    pending = lines.pop() || ''
    for (const ln of lines) consumeLine(ln)
  }
  function flush() {
    const rest = pending
    pending = ''
    if (rest) consumeLine(rest)
  }
  return { pushChunk, flush }
}

// ── 状态引擎（按项目目录聚合的运行状态表）────────────────────────────────────
// opts.publish(snapshot) —— 每次状态变化后回调（preset: ctx.emit 事件；
// dynamic: 推给家级收集器；MCP: 传 null，按需构建）。
function createStatusEngine(opts) {
  const publish = (opts && typeof opts.publish === 'function') ? opts.publish : null
  const projects = Object.create(null)

  function ensureProject(cwd) {
    const key = String(cwd || '')
    let p = projects[key]
    if (!p) {
      if (Object.keys(projects).length >= MAX_PROJECTS) {
        // MRU 淘汰：优先淘汰空闲项目；全忙时淘汰最久未活跃的。
        const idle = Object.keys(projects).filter(function (k) { return projects[k].running === 0 })
        const pool = idle.length ? idle : Object.keys(projects)
        const victim = pool.sort(function (a, b) { return projects[a].updatedAt - projects[b].updatedAt })[0]
        delete projects[victim]
      }
      p = { cwd: key, name: projectName(key), state: 'idle', running: 0, lastStatus: null, lastAt: 0, lastSessionId: null, lastOk: false, lastFailed: false, fallbackActive: false, current: null, trail: [], runs: 0, totalTokens: 0, updatedAt: 0 }
      projects[key] = p
    }
    return p
  }

  function globalStatus() {
    const list = Object.keys(projects).map(function (k) { return projects[k] })
    let running = 0, lastStatus = null, lastAt = 0, lastSessionId = null, fallbackActive = false, current = null, trail = [], updatedAt = 0, runs = 0, totalTokens = 0
    for (const p of list) {
      running += p.running
      if (p.updatedAt > updatedAt) updatedAt = p.updatedAt
      if (p.running > 0 && !current && p.current) current = p.current
      if (p.lastAt > lastAt) { lastAt = p.lastAt; lastStatus = p.lastStatus; lastSessionId = p.lastSessionId }
      if (p.fallbackActive) fallbackActive = true
      runs += p.runs || 0
      totalTokens += p.totalTokens || 0
      for (const e of p.trail) trail.push(e)
    }
    trail.sort(function (a, b) { return (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) })
    trail = trail.slice(-MAX_TRAIL)
    const state = running > 0 ? 'running' : (fallbackActive ? 'fallback' : (lastStatus ? (lastStatus === 'SUCCESS' ? 'ok' : 'failed') : 'idle'))
    return { state: state, running: running, lastStatus: lastStatus, lastAt: lastAt, lastSessionId: lastSessionId, fallbackActive: fallbackActive, current: current, trail: trail, runs: runs, totalTokens: totalTokens, updatedAt: updatedAt }
  }

  function statusSnapshot() {
    const g = globalStatus()
    const list = Object.keys(projects).map(function (k) { return projects[k] }).sort(function (a, b) { return b.updatedAt - a.updatedAt })
    return {
      state: g.state, running: g.running, lastStatus: g.lastStatus, lastAt: g.lastAt, lastSessionId: g.lastSessionId, fallbackActive: g.fallbackActive, current: g.current, trail: g.trail, runs: g.runs, totalTokens: g.totalTokens, updatedAt: g.updatedAt,
      projects: list.map(function (p) { return { cwd: p.cwd, name: p.name, state: p.state, running: p.running, current: p.current, trail: p.trail.slice(-MAX_TRAIL), lastStatus: p.lastStatus, lastAt: p.lastAt, lastSessionId: p.lastSessionId, fallbackActive: p.fallbackActive, runs: p.runs || 0, totalTokens: p.totalTokens || 0, updatedAt: p.updatedAt } })
    }
  }

  function emit() { if (publish) { try { publish(statusSnapshot()) } catch (e) {} } }

  function begin(cwd) {
    const p = ensureProject(cwd)
    p.running += 1
    p.state = 'running'
    p.updatedAt = Date.now()
    emit()
  }

  function end(res, cwd) {
    const p = ensureProject(cwd)
    p.running = Math.max(0, p.running - 1)
    p.lastStatus = res ? res.status : null
    p.lastAt = Date.now()
    if (res && res.sessionId) p.lastSessionId = res.sessionId
    // 用量累计（codebuddy 无套餐额度 API，以按项目 token 计量作替代观察）
    p.runs = (p.runs || 0) + 1
    if (res && typeof res.totalTokens === 'number' && res.totalTokens > 0) p.totalTokens = (p.totalTokens || 0) + res.totalTokens
    if (res && res.fallback) { p.fallbackActive = true; p.state = 'fallback' }
    else if (p.running > 0) { p.state = 'running' }
    else { p.state = res && res.ok ? 'ok' : 'failed'; p.lastOk = !!(res && res.ok); p.lastFailed = !(res && res.ok) }
    p.current = null
    p.updatedAt = Date.now()
    emit()
  }

  // 流事件折叠为实时状态（current 步骤 + trail）。
  function foldEvent(ev, cwd) {
    const p = ensureProject(cwd)
    p.updatedAt = Date.now()
    if (!ev || !ev.type) return
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          p._stepCounter = (p._stepCounter || 0) + 1
          const stepIndex = p._stepCounter
          if (!p._toolMap) p._toolMap = {}
          p._toolMap[block.id] = { stepIndex: stepIndex, name: block.name }
          const args = summarizeArgs(block.input)
          p.trail.push({ stepIndex: stepIndex, state: 'ACTIVE', tool: block.name, args: args, at: new Date().toISOString() })
          if (p.trail.length > MAX_TRAIL) p.trail.shift()
          p.current = { tool: block.name, args: args, stepIndex: stepIndex, since: new Date().toISOString() }
        } else if (block.type === 'thinking') {
          p.current = { tool: 'thinking', args: { text: String(block.thinking || '').slice(0, MAX_ARG_LEN) }, stepIndex: 0, since: new Date().toISOString() }
        } else if (block.type === 'text') {
          p.current = { tool: 'typing', args: { text: String(block.text || '').slice(0, MAX_ARG_LEN) }, stepIndex: 0, since: new Date().toISOString() }
        }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_result' && p._toolMap && p._toolMap[block.tool_use_id]) {
          const rec = p._toolMap[block.tool_use_id]
          p.trail.push({ stepIndex: rec.stepIndex, state: block.is_error ? 'ERROR' : 'DONE', tool: rec.name, args: null, at: new Date().toISOString() })
          if (p.trail.length > MAX_TRAIL) p.trail.shift()
          if (p.current && p.current.stepIndex === rec.stepIndex) p.current = null
        }
      }
    }
    emit()
  }

  // codebuddy 会话按项目目录（cwd）归档：续接（--resume/--continue）未显式给
  // cwd 时，优先回落到该 session 所在项目的 cwd，否则换个目录会
  // "No conversation found with session ID"。
  function resolveCwd(args, fallbackCwd) {
    if (args && args.cwd) return String(args.cwd)
    if (args && (args.sessionId || args.continueLatest)) {
      const list = Object.keys(projects).map(function (k) { return projects[k] }).sort(function (a, b) { return b.updatedAt - a.updatedAt })
      if (args.sessionId) {
        const hit = list.find(function (p) { return p.lastSessionId === args.sessionId })
        if (hit) return hit.cwd
      } else if (list.length && list[0].lastSessionId) {
        return list[0].cwd
      }
    }
    return fallbackCwd
  }

  return { projects: projects, ensureProject: ensureProject, globalStatus: globalStatus, statusSnapshot: statusSnapshot, begin: begin, end: end, foldEvent: foldEvent, resolveCwd: resolveCwd }
}

// ── 工具渲染（preset 与 dynamic 共用的纯展示层）─────────────────────────────

function renderResult(value) {
  const v = value || {}
  if (v.background) {
    return [{ type: 'text', text: 'codebuddy dispatched in background (mode=' + v.mode + '). jobId=' + v.jobId + '. Collect with job_output.' }]
  }
  if (v.fallback) {
    return [{ type: 'text', text: 'codebuddy 回退：用户选择使用 DSH 本地 API 配置（原因 ' + v.reason + '）。请改用原生工具/本地模型完成本任务，不要再调 codebuddy。' }]
  }
  const head = 'codebuddy ' + (v.ok ? 'OK' : 'FAILED') + ' [status=' + v.status + ' mode=' + v.mode + (v.sessionId ? ' session=' + v.sessionId : '') + (v.totalTokens != null ? ' tokens=' + v.totalTokens : '') + (v.durationSeconds != null ? ' ' + v.durationSeconds + 's' : '') + ']'
  const body = v.response ? v.response : (v.stderr ? '[stderr] ' + v.stderr : (v.rawStdout ? '[raw] ' + v.rawStdout : ''))
  return [{ type: 'text', text: head + (body ? '\n\n' + body : '') }]
}

function renderStatus(value) {
  const v = value || {}
  const lines = []
  lines.push('codebuddy status: ' + v.state + (v.running > 0 ? ' (' + v.running + ' running)' : '') + (v.projects && v.projects.length > 1 ? ' across ' + v.projects.length + ' projects' : '') + (v.totalTokens ? ' | Σ ' + v.runs + ' runs · ' + v.totalTokens + ' tokens' : ''))
  const projList = (v.projects && v.projects.length) ? v.projects : null
  if (projList) {
    for (const p of projList) {
      const cur = p.current ? (' step ' + p.current.stepIndex + ' → ' + p.current.tool + (p.current.args ? ' ' + JSON.stringify(p.current.args) : '')) : (p.running > 0 ? ' (starting / thinking)' : '')
      const usage = (p.runs ? ' | Σ ' + p.runs + ' runs · ' + (p.totalTokens || 0) + ' tokens' : '')
      lines.push('· ' + p.name + ' [' + p.state + (p.running > 0 ? ' ×' + p.running : '') + ']' + cur + (p.lastStatus ? ' | last=' + p.lastStatus + (p.lastSessionId ? ' ' + p.lastSessionId.slice(0, 8) : '') : '') + usage)
      if (p.trail && p.trail.length) {
        lines.push('    steps:')
        for (const e of p.trail.slice(-3)) { const a = e.args ? ' ' + JSON.stringify(e.args) : ''; lines.push('      [' + e.state + '] step ' + e.stepIndex + ' ' + e.tool + a) }
      }
    }
  } else {
    if (v.current) { const c = v.current; lines.push('current: step ' + c.stepIndex + ' → ' + c.tool + (c.args ? ' ' + JSON.stringify(c.args) : '')) }
    else if (v.state === 'running') { lines.push('current: (starting / thinking)') }
    if (v.trail && v.trail.length) {
      lines.push('recent steps:')
      for (const e of v.trail.slice(-6)) { const a = e.args ? ' ' + JSON.stringify(e.args) : ''; lines.push('  [' + e.state + '] step ' + e.stepIndex + ' ' + e.tool + a) }
    }
    if (v.lastStatus) lines.push('last: ' + v.lastStatus + (v.lastSessionId ? ' session=' + v.lastSessionId : '') + (v.lastAt ? ' @ ' + new Date(v.lastAt).toISOString() : ''))
  }
  if (v.updatedAt) lines.push('updatedAt: ' + new Date(v.updatedAt).toISOString())
  return [{ type: 'text', text: lines.join('\n') }]
}

// ── preset/dynamic 共享的文案 ────────────────────────────────────────────────

const FALLBACK_LABEL = '使用 DSH 本地 API 配置（回退）'
const RETRY_LABEL = '重试 codebuddy 一次'
const CANCEL_LABEL = '不回退（返回错误）'

const POLICY_TEXT = [
  'codebuddy-first execution policy (local codebuddy CLI bridge, with fallback + live indicator + live status tool).',
  '',
  'A local sub-agent CLI named "codebuddy" (Tencent CodeBuddy Code) is available through the codebuddy_run and codebuddy_continue tools. DSH fully controls codebuddy: every invocation runs non-interactively with permissions auto-approved (--permission-mode bypassPermissions), so codebuddy never prompts and DSH decides all of its work. A header status light shows when codebuddy is working — one light per project (working directory), so parallel runs in different projects are tracked separately; call codebuddy_status any time to see what codebuddy is doing right now (per project: current tool/step, recent trail, and cumulative usage).',
  '',
  'Priority rule for EVERY mode (normal, plan, accept-edits, subagent/workflow/ralph delegation, and goal rounds):',
  '- For any real work — implementing features, editing/refactoring code, debugging, running builds, or multi-file investigation — prefer dispatching the task to codebuddy_run FIRST with a complete, self-contained prompt.',
  '- Use native read/write/shell tools mainly for quick read-only lookups and for the final build/test verification of what codebuddy produced.',
  '- In plan mode, call codebuddy_run with mode=auto (or mode=plan); in accept-edits/normal mode codebuddy_run applies edits directly.',
  '- When you delegate to a DSH subagent or workflow, instruct that delegate to also prefer codebuddy_run.',
  '- For long-running tasks, call codebuddy_run with background=true and collect the result with job_output; use codebuddy_status to watch progress.',
  '',
  'Fallback protocol: when codebuddy is rate-limited or the network is down, codebuddy_run/codebuddy_continue automatically pop a confirmation dialog asking the user whether to use the DSH local API config. If the returned result has fallback=true (status FALLBACK_TO_DSH), the user chose to fall back: complete the task with native DSH tools / the local model and DO NOT call codebuddy again for this task. If ok=false without fallback, report the codebuddy error. Never loop codebuddy calls; never ask codebuddy to call back into DSH.',
  '',
  'Model selection: codebuddy_run takes an optional model. When unspecified, codebuddy uses its configured default model (currently hy4-preview). Supported models: hy4-preview, hy3, hy3-x, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.7, kimi-k2.6, deepseek-v4-pro, deepseek-v4-flash. Pass a model only when the task clearly benefits from a specific one (e.g. a heavyweight refactor vs a quick lookup); the default is usually right. Optional effort: minimal/low/medium/high/xhigh/max. Optional maxTurns caps agentic turns (default unlimited).'
].join('\n')

// ── 执行编排（preset 与 dynamic 共用；MCP 的 stdio 编排见其适配层）──────────
// o: {
//   ctx,                     // Cordis ctx（interval/timeout/get）
//   subprocess,              // DSH subprocess 服务
//   engine,                  // createStatusEngine(...) 实例
//   resolveCodebuddyExe,     // async (execSignal) => 'exe' | [nodeExe, binPath]
//   getCwdFallback,          // () => 默认 cwd（DSH workspaceRoot || 常量）
//   defaultMode              // 'auto'（DSH preset/dynamic）
// }
function createRunner(o) {
  const ctx = o.ctx
  const subprocess = o.subprocess
  const engine = o.engine
  const stdio = {
    stdin: 'ignore',
    stdout: { maxBytes: 4000000, spill: { maxBytes: 40000000 } },
    stderr: { maxBytes: 1000000, spill: { maxBytes: 8000000 } }
  }

  function readStreams(handle) {
    const stdoutText = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const stderrText = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    return { stdoutText: stdoutText, stderrText: stderrText }
  }

  // 半行安全的实时解析：250ms 轮询读增量，行边界由 createLineStream 保证。
  function startLiveParser(handle, cwd) {
    let cursor = 0
    const stream = createLineStream(function (ln) {
      const t = ln.trim()
      if (!t.startsWith('{')) return
      try { const obj = JSON.parse(t); engine.foldEvent(obj, cwd) } catch (e) {}
    })
    const tick = function () {
      try {
        const full = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        if (full.length <= cursor) return
        const fresh = full.slice(cursor)
        cursor = full.length
        stream.pushChunk(fresh)
      } catch (e) {}
    }
    const disposeInterval = ctx.interval(tick, 250)
    // 结束时冲刷残余半行（末行可能无换行符）。
    return function disposeLive() {
      try { stream.flush() } catch (e) {}
      disposeInterval()
    }
  }

  async function runSync(argv, cwd, timeoutSec, callerSignal) {
    const spec = { argv: argv, cwd: cwd, stdio: stdio, graceMs: 5000 }
    if (callerSignal) spec.signal = callerSignal
    const handle = subprocess.spawn(spec)
    let lastEventSummary = '(no events yet)'
    let timedOut = false
    const disposeTimer = ctx.timeout(function () {
      timedOut = true
      try {
        const p = engine.ensureProject(cwd)
        lastEventSummary = (p.current ? ('last step ' + p.current.stepIndex + ' -> ' + p.current.tool) : '') +
          ' | trail=' + (p.trail.length ? p.trail.slice(-2).map(function (e) { return '[' + e.state + ']' + e.tool }).join(',') : 'empty') +
          ' | elapsed=' + Math.round((Date.now() - (p.updatedAt || Date.now())) / 1000) + 's since last activity'
      } catch (e) {}
      try { handle.terminate() } catch (e) {}
    }, (timeoutSec + 60) * 1000)
    const disposeLive = startLiveParser(handle, cwd)
    try {
      const outcome = await handle.done
      const s = readStreams(handle)
      return { outcome: outcome, stdoutText: s.stdoutText, stderrText: s.stderrText, timedOut: timedOut, lastEventSummary: lastEventSummary }
    } finally {
      disposeLive()
      disposeTimer()
    }
  }

  async function askFallback(exec, res, canRetry) {
    const uq = ctx.get('userQuestions')
    if (!uq || !exec || !exec.agent) return 'error'
    const detail = String(res.stderr || res.response || res.status || '').slice(-600)
    // canRetry=false 时不再提供「重试」选项（已达 2 次上限），避免死选项。
    const opts = [ { label: FALLBACK_LABEL, description: '本次改由 DSH 本地模型/原生工具完成，不再走 codebuddy' } ]
    if (canRetry) opts.push({ label: RETRY_LABEL, description: '再调用一次 codebuddy（网络抖动时可用）' })
    opts.push({ label: CANCEL_LABEL, description: '不回退，直接返回 codebuddy 错误' })
    try {
      const ans = await uq.ask({ agent: exec.agent, signal: exec.signal, questions: [{ id: 'codebuddy-fallback', header: 'codebuddy 受限', question: 'codebuddy 调用失败（疑似流量受限/网络不通，状态=' + String(res.status) + '）。是否改用 DSH 本地 API 配置继续？', detail: detail, options: opts }] })
      const sel = (ans && ans.answers && ans.answers[0] && ans.answers[0].selected) || []
      if (sel.indexOf(FALLBACK_LABEL) >= 0) return 'fallback'
      if (sel.indexOf(RETRY_LABEL) >= 0) return 'retry'
      return 'error'
    } catch (e) { return 'error' }
  }

  async function coreExecute(rawArgs, exec) {
    const args = rawArgs || {}
    if (!args.prompt || !String(args.prompt).trim()) {
      return { ok: false, status: 'BAD_ARGS', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: 'auto', stderr: 'prompt is required' }
    }
    let exePrefix = ['codebuddy']
    let exeOk = true
    let resolveErr = ''
    try {
      const resExe = await o.resolveCodebuddyExe(exec ? exec.signal : undefined)
      exePrefix = Array.isArray(resExe) ? resExe : [resExe]
    } catch (e) { exeOk = false; resolveErr = String(e && e.message || e) }
    const cwd = engine.resolveCwd(args, o.getCwdFallback())
    const built = buildArgv(exePrefix, args, { planActive: o.planActiveFor ? o.planActiveFor(exec) : false, defaultMode: o.defaultMode || 'auto' })

    if (!exeOk) {
      engine.begin(cwd)
      let res = { ok: false, status: 'CODEBUDDY_UNAVAILABLE', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, stderr: 'codebuddy executable not found: ' + resolveErr }
      if (await askFallback(exec, res, true) === 'fallback') res = fallbackResult(res, built.mode)
      engine.end(res, cwd)
      return res
    }

    const jobs = ctx.get('jobs')
    if (args.background && jobs && exec && exec.agent) {
      try {
        engine.begin(cwd)
        const jobId = jobs.start({
          kind: 'bash',
          label: 'codebuddy: ' + shortLabel(args.prompt),
          owner: exec.agent,
          run() {
            const handle = subprocess.spawn({ argv: built.argv, cwd: cwd, stdio: stdio, graceMs: 5000 })
            const disposeLive = startLiveParser(handle, cwd)
            // 后台路径同样有挂起守卫（timeoutSec+60s 强杀），与前台 runSync 一致。
            let bgKilled = false
            const disposeGuard = ctx.timeout(function () { bgKilled = true; try { handle.terminate() } catch (e) {} }, (built.timeoutSec + 60) * 1000)
            const done = handle.done.then(function (outcome) {
              disposeLive(); disposeGuard()
              const s = readStreams(handle)
              const res = buildResult(parseCodebuddyJson(s.stdoutText), outcome, built.mode, s.stderrText, s.stdoutText)
              if (bgKilled && !res.ok) {
                res.status = 'HUNG_TIMEOUT'
                res.stderr = (res.stderr ? res.stderr + ' ' : '') + '[killed by timeout guard after ' + built.timeoutSec + 's; if this was a long-running script (build/test) raise timeoutSec]'
              }
              engine.end(res, cwd)
              return { status: res.ok ? 'completed' : 'failed', detail: 'codebuddy ' + res.status, output: JSON.stringify(res) }
            }).catch(function (err) {
              disposeLive(); disposeGuard()
              engine.end({ ok: false, status: 'JOB_ERROR' }, cwd)
              return { status: 'failed', detail: String(err && err.message || err) }
            })
            return { cancel: function () { try { handle.terminate() } catch (e) {} }, done: done }
          }
        })
        return { ok: true, background: true, jobId: String(jobId), mode: built.mode, note: 'codebuddy running in background; collect with job_output ' + String(jobId) + '. Background failures do NOT open the fallback dialog; on failure re-run in foreground to be prompted.' }
      } catch (e) {
        // jobs.start 失败必须 return，否则会静默落到下面的前台路径再跑一遍。
        const res = { ok: false, status: 'JOB_START_ERROR', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, stderr: 'failed to start background job: ' + String(e && e.message || e) }
        engine.end(res, cwd)
        return res
      }
    }

    engine.begin(cwd)
    try {
      let attempt = 0
      let res
      while (true) {
        attempt += 1
        const r = await runSync(built.argv, cwd, built.timeoutSec, exec ? exec.signal : undefined)
        if (r.timedOut) {
          res = { ok: false, status: 'HUNG_TIMEOUT', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: r.outcome ? r.outcome.exitCode : null, mode: built.mode, stderr: 'codebuddy did not finish within ' + built.timeoutSec + 's (DSH hard timeout). Last activity: ' + r.lastEventSummary + '. NOTE: if the task was a long-running script (build/test), raise timeoutSec; this was a hang guard, not necessarily a failure of codebuddy.' }
          break
        }
        res = buildResult(parseCodebuddyJson(r.stdoutText), r.outcome, built.mode, r.stderrText, r.stdoutText)
        if (res.ok || !isLimited(res)) break
        // 限流/网络类失败：每次失败弹一次三选一；「重试」仅在还有次数时提供。
        // （不再有循环外的第二次弹窗 —— 修复旧版「双弹窗 + 死选项」。）
        const decision = await askFallback(exec, res, attempt < 2)
        if (decision === 'fallback') { res = fallbackResult(res, built.mode); break }
        if (decision === 'retry' && attempt < 2) continue
        break
      }
      engine.end(res, cwd)
      return res
    } catch (e) {
      const res = { ok: false, status: 'SPAWN_ERROR', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, stderr: String(e && e.message || e) }
      const out = (await askFallback(exec, res, true) === 'fallback') ? fallbackResult(res, built.mode) : res
      engine.end(out, cwd)
      return out
    }
  }

  return { coreExecute: coreExecute, runSync: runSync, askFallback: askFallback }
}


const CWD_FALLBACK = 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'

return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    const subprocess = ctx.subprocess
    const planMode = ctx.get('planMode')
    const sandboxPolicy = ctx.get('sandboxPolicy')

    // 动态沙箱无 ctx.emit：状态变化推给家级收集器（codebuddy-indicator 提供
    // codebuddyCollector 服务），由其 /codebuddy-indicator/status 路由统一暴露。
    const engine = createStatusEngine({
      publish: function (snap) {
        try {
          const collector = ctx.get('codebuddyCollector')
          if (collector && typeof collector.mergeSnapshot === 'function') collector.mergeSnapshot(snap)
        } catch (e) { }
      }
    })

    function planActiveFor(exec) {
      try {
        if (planMode && exec && exec.agent) {
          const st = planMode.get(exec.agent)
          return !!(st && st.active)
        }
      } catch (e) {}
      return false
    }

    // 沙箱内无 process/env：node 经 subprocess 解析；npm bin 路径为固定回退。
    async function resolveCodebuddyExe(execSignal) {
      try {
        const exe = await subprocess.resolveExecutable('codebuddy', undefined, execSignal)
        // npm 安装的 codebuddy 只有 .cmd shim，Node 直接 spawn .cmd/.bat 会 EINVAL
        // （CVE-2024-27980 加固后）；命中 .cmd/.bat 时改走 node + bin 脚本。
        if (!/\.(cmd|bat)$/i.test(exe)) return exe
      } catch (e) {}
      let nodeExe = 'node'
      try { nodeExe = await subprocess.resolveExecutable('node', undefined, execSignal) } catch (e) {}
      return [nodeExe, 'C:\\Users\\lcl\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy']
    }

    const runner = createRunner({
      ctx: ctx,
      subprocess: subprocess,
      engine: engine,
      resolveCodebuddyExe: resolveCodebuddyExe,
      getCwdFallback: function () {
        return (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) || CWD_FALLBACK
      },
      planActiveFor: planActiveFor,
      defaultMode: 'auto'
    })
    const coreExecute = runner.coreExecute

    // Client 可经包私有 JSON 方法读取快照。
    harness.handle('codebuddy_status', function () { return engine.statusSnapshot() })

    const OUT = { schema: { type: 'object', additionalProperties: true }, render: renderResult }
    const STATUS_OUT = { schema: { type: 'object', additionalProperties: true }, render: renderStatus }

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_run', description: 'Dispatch a coding/build/debug/investigation task to the local codebuddy agent CLI and return its final answer. DSH fully controls codebuddy (--permission-mode bypassPermissions; codebuddy never prompts). On rate-limit/network failure DSH pops a fallback dialog; fallback=true means finish with native tools. background=true returns a jobId. While it runs, call codebuddy_status to watch what codebuddy is doing live.', parameters: { prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.', required: true }, mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits.' }, model: { type: 'string', description: 'Optional codebuddy model id.' }, effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' }, maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500).' }, cwd: { type: 'string', description: 'Working directory for codebuddy.' }, addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to codebuddy workspace.' }, timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' }, background: { type: 'boolean', description: 'Run as a background job and return a jobId.' } }, output: OUT, execute: function (args, exec) { return coreExecute(args, exec) } }))

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_continue', description: 'Continue an existing codebuddy conversation with a follow-up prompt. Pass sessionId or set latest=true. Same DSH-controlled, no-prompt execution and same fallback dialog as codebuddy_run.', parameters: { prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codebuddy conversation.', required: true }, sessionId: { type: 'string', description: 'codebuddy session id to resume.' }, latest: { type: 'boolean', description: 'Continue the most recent codebuddy conversation.' }, mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode.' }, model: { type: 'string', description: 'Optional codebuddy model id.' }, effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' }, maxTurns: { type: 'integer', description: 'Optional max agentic turns.' }, cwd: { type: 'string', description: "Working directory for codebuddy; when resuming, defaults to the resumed session's project directory." }, timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' }, background: { type: 'boolean', description: 'Run as a background job and return a jobId.' } }, output: OUT, execute: function (args, exec) { const a = args || {}; const mapped = { prompt: a.prompt, mode: a.mode, model: a.model, effort: a.effort, maxTurns: a.maxTurns, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background }; if (a.sessionId) mapped.sessionId = a.sessionId; else if (a.latest) mapped.continueLatest = true; return coreExecute(mapped, exec) } }))

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_status', description: 'Read a live snapshot of what the local codebuddy agent is currently doing. Returns one section per project (working directory): running count, current step (tool name + arguments being executed, or agent_response thinking/typing), recent step trail, last completed run status + session id, and per-project cumulative usage (runs + total tokens, since codebuddy exposes no quota API). Call this to check on an in-flight codebuddy_run/codebuddy_continue without waiting for it to finish.', parameters: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } }, output: STATUS_OUT, execute: function (args) { const a = args || {}; const snap = engine.statusSnapshot(); if (a.cwd) { const key = String(a.cwd); snap.projects = snap.projects.filter(function (p) { return p.cwd === key }); const g = snap.projects[0]; if (g) { snap.state = g.state; snap.running = g.running; snap.current = g.current; snap.trail = g.trail; snap.lastStatus = g.lastStatus; snap.lastAt = g.lastAt; snap.lastSessionId = g.lastSessionId; snap.fallbackActive = g.fallbackActive; snap.runs = g.runs; snap.totalTokens = g.totalTokens; snap.updatedAt = g.updatedAt } } return snap } }))

    ctx.systemPrompt.section({ name: 'codebuddy:policy', order: 5, text: POLICY_TEXT })
  }
}
