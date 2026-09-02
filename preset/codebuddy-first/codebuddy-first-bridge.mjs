// codebuddy-first-bridge.mjs — DSH preset 适配层。
//
// 共享逻辑（纯函数 + 状态引擎 + 执行编排 + 渲染 + 文案）在 ./codebuddy-core.mjs
// （单一事实来源，同时供 dynamic/host.js 生成与 MCP server 复用）；本文件只
// 保留 preset 宿主适配：ctx.tools 注册、codebuddy/* 事件发布、codebuddy 可执行
// 文件解析（本形态可用 process/env）、DSH 工具面（JSON Schema 形态）。
//
// 沙箱论证：本插件只向 tools/systemPrompt 注册，不发布服务，因此无需
// isolate realm（详见 docs/ARCHITECTURE.md）。

import {
  createStatusEngine, createRunner, renderResult, renderStatus, POLICY_TEXT
} from './codebuddy-core.mjs'

export const name = 'codebuddy-first-bridge'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'timer']

const CWD_FALLBACK = 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

export function apply(ctx) {
  const subprocess = ctx.subprocess
  const planMode = ctx.get('planMode')
  const sandboxPolicy = ctx.get('sandboxPolicy')

  // 状态引擎：按项目（cwd）聚合；preset 通过 ctx.emit('codebuddy/status') 推送，
  // 家级 codebuddy-indicator 监听同事件并汇入全局表。
  const engine = createStatusEngine({
    publish: (snap) => { ctx.emit('codebuddy/status', { snapshot: snap }) }
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

  // preset 形态运行在 DSH host 进程内：可用 process.env。
  // backend='codebuddy'：PATH → CODEBUDDY_BIN → npm 全局 bin（.cmd shim 走
  //   node+bin，规避 CVE-2024-27980 后 spawn .cmd/.bat 的 EINVAL）。
  // backend='workbuddy'：WORKBUDDY_BIN → WorkBuddy 桌面版自带 CLI（与 codebuddy
  //   同引擎同协议，办公场景产品面：文档/PPT/知识库/图片视频生成/微信企微回复）。
  async function resolveExe(backend, execSignal) {
    if (backend === 'workbuddy') {
      const nodeExe = process.execPath || 'node'
      const wbBin = process.env.WORKBUDDY_BIN || 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
      return [nodeExe, wbBin]
    }
    try {
      const exe = await subprocess.resolveExecutable('codebuddy', undefined, execSignal)
      // npm 安装的 codebuddy 只有 .cmd shim，Node 直接 spawn .cmd/.bat 会 EINVAL
      // （CVE-2024-27980 加固后）；命中 .cmd/.bat 时改走 node + bin 脚本。
      if (!/\.(cmd|bat)$/i.test(exe)) return exe
    } catch (e) {}
    // 回退：node 直接跑 npm 全局 bin 脚本（codebuddy 通常不在 DSH 进程 PATH 里）。
    const nodeExe = process.execPath || 'node'
    const binPath = process.env.CODEBUDDY_BIN || (process.env.APPDATA || 'C:\\Users\\lcl\\AppData\\Roaming') + '\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy'
    return [nodeExe, binPath]
  }

  const runner = createRunner({
    ctx: ctx,
    subprocess: subprocess,
    engine: engine,
    resolveExe: resolveExe,
    getCwdFallback: function () {
      return (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) || CWD_FALLBACK
    },
    planActiveFor: planActiveFor,
    defaultMode: 'auto'
  })
  const coreExecute = runner.coreExecute

  // 本会话身份（兜底通道）：host 侧首选自己实时枚举 agents.list() +
  // agentPresets.composedPreset() 判定哪些会话是 codebuddy-first（见
  // home-plugin/lib/index.mjs 注释）；这里的上报是那条通道失灵时的备份。
  // 注意 apply() 阶段 agent 通常尚未就位（preset 正在被组合进去），所以：
  //   ① 先试 agents.currentInitiator()（组合发生在 withInitiator 链上时可得）；
  //   ② 拿不到就等第一次工具调用，从 exec.agent 补记（planActiveFor 已证实该字段）。
  // 全程防御：取不到就退化为不带 sessionId 的旧全局语义，不影响主通道。
  let SELF_SESSION_ID = null
  function sessionIdOf(agent) {
    if (!agent) return null
    const sid = agent.id || (agent.session && agent.session.id)
    return typeof sid === 'string' && sid ? sid : null
  }
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents && typeof agents.currentInitiator === 'function') SELF_SESSION_ID = sessionIdOf(agents.currentInitiator())
  } catch (e) { }

  function announceMode(active) {
    try {
      const payload = { active: active !== false }
      if (SELF_SESSION_ID) payload.sessionId = SELF_SESSION_ID
      ctx.emit('codebuddy/mode', payload)
    } catch (e) { }
  }
  // 第一次工具调用时补记会话身份（apply 阶段拿不到的情况）。
  function noteSession(exec) {
    if (SELF_SESSION_ID) return
    try {
      const sid = sessionIdOf(exec && exec.agent)
      if (sid) { SELF_SESSION_ID = sid; announceMode(true) }
    } catch (e) { }
  }
  announceMode(true)
  try {
    const t = ctx.setInterval ? ctx.setInterval(function () { announceMode(true) }, 30000) : null
    if (ctx.effect) ctx.effect(() => () => {
      try { if (t) t() } catch (e) { }
      // 会话卸载时主动下线：本会话的灯立刻熄灭，不必等 75s 租约到期。
      announceMode(false)
    })
  } catch (e) { }

  const runTool = {
    name: 'codebuddy_run',
    description: 'Dispatch a coding/build/debug/investigation task to the local codebuddy agent CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls codebuddy: it always runs non-interactively with permissions auto-approved (codebuddy never prompts). Use read-only native tools only for quick lookups and for final build/test verification. In mode=auto the DSH plan state decides plan vs bypassPermissions. Set background=true for long tasks and collect the result via job_output.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.' },
        backend: { type: 'string', enum: ['codebuddy', 'workbuddy'], description: 'Which local CLI to dispatch to. codebuddy (default, CodeBuddy Code) for coding work; workbuddy (Tencent WorkBuddy, same engine, office-scenario product face) for office tasks: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies. Continuing a session routes back to its owning backend automatically.' },
        mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits. Default auto.' },
        model: { type: 'string', description: 'Optional codebuddy model id. When unspecified, codebuddy uses its configured default model (currently hy4-preview). Supported models: hy4-preview, hy3, hy3-x, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.7, kimi-k2.6, deepseek-v4-pro, deepseek-v4-flash. Pass a model only when the task clearly benefits from a specific one.' },
        effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' },
        maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500, default unlimited).' },
        cwd: { type: 'string', description: 'Working directory for codebuddy. Defaults to the DSH workspace root.' },
        addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to codebuddy workspace.' },
        timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' },
        background: { type: 'boolean', description: 'Run as a background job and return a jobId immediately.' }
      }
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    execute(args, exec) { noteSession(exec); return coreExecute(args, exec) }
  }

  const continueTool = {
    name: 'codebuddy_continue',
    description: 'Continue an existing codebuddy conversation with a follow-up prompt, reusing codebuddy context. Pass sessionId from a prior codebuddy_run result, or set latest=true to continue the most recent codebuddy conversation. Same DSH-controlled, no-prompt execution as codebuddy_run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codebuddy conversation.' },
        sessionId: { type: 'string', description: 'codebuddy session id to resume (from a prior codebuddy_run result).' },
        latest: { type: 'boolean', description: 'Continue the most recent codebuddy conversation instead of a specific id.' },
        backend: { type: 'string', enum: ['codebuddy', 'workbuddy'], description: 'Which CLI to resume on. When omitted, the backend that owns the sessionId is used automatically.' },
        mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode; default auto.' },
        model: { type: 'string', description: 'Optional codebuddy model id.' },
        effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' },
        maxTurns: { type: 'integer', description: 'Optional max agentic turns.' },
        cwd: { type: 'string', description: "Working directory for codebuddy; when resuming, defaults to the resumed session's project directory." },
        timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' },
        background: { type: 'boolean', description: 'Run as a background job and return a jobId immediately.' }
      }
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    execute(args, exec) {
      noteSession(exec)
      const a = args || {}
      const mapped = { prompt: a.prompt, backend: a.backend, mode: a.mode, model: a.model, effort: a.effort, maxTurns: a.maxTurns, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background }
      if (a.sessionId) mapped.sessionId = a.sessionId
      else if (a.latest) mapped.continueLatest = true
      return coreExecute(mapped, exec)
    }
  }

  const statusTool = {
    name: 'codebuddy_status',
    description: 'Read a live snapshot of what the local codebuddy agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), the last completed run status + session id, and per-project cumulative usage (runs + total tokens, since codebuddy exposes no quota API). Optional cwd filters to a single project. Call this to check on an in-flight codebuddy_run/codebuddy_continue without waiting for it to finish.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } },
    output: { schema: OUTPUT_SCHEMA, render: renderStatus },
    execute(args) {
      const a = args || {}
      const snap = engine.statusSnapshot()
      if (a.cwd) {
        const key = String(a.cwd)
        snap.projects = snap.projects.filter((p) => p.cwd === key)
        const g = snap.projects[0]
        if (g) { snap.state = g.state; snap.running = g.running; snap.current = g.current; snap.trail = g.trail; snap.lastStatus = g.lastStatus; snap.lastAt = g.lastAt; snap.lastSessionId = g.lastSessionId; snap.lastBackend = g.lastBackend; snap.fallbackActive = g.fallbackActive; snap.runs = g.runs; snap.totalTokens = g.totalTokens; snap.updatedAt = g.updatedAt }
      }
      return snap
    }
  }

  ctx.effect(() => ctx.tools.register(runTool))
  ctx.effect(() => ctx.tools.register(continueTool))
  ctx.effect(() => ctx.tools.register(statusTool))

  ctx.effect(() => ctx.systemPrompt.section({ name: 'codebuddy:policy', order: 5, text: POLICY_TEXT }))
}
