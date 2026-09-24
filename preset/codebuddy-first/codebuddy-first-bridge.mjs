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
  createStatusEngine, createRunner, renderResult, renderStatus, POLICY_TEXT,
  BACKENDS, DEFAULT_BACKEND, BACKEND_AUTH_IDS, AUTH_DOMAIN_ENDPOINTS, endpointEnv
} from './codebuddy-core.mjs'
// 仅用于读登录域（auth 库的 auth.domain 是明文）。本形态是宿主进程内的真实 ESM
// 模块，Node 内建模块可直接静态导入；dynamic 形态（沙箱内 new Function）则不用本文件。
import { readFileSync } from 'node:fs'

export const name = 'codebuddy-first-bridge'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'timer']

// ── 插件设置（v1.3.0）────────────────────────────────────────────────────────
// 新 DSH 的设置面板（dsh-settings SettingsForms）把「active 插件条目的 Config」
// 自动投影成表单：带 .volatile() 标记的字段可热编辑，改动写入 profile 用户补丁，
// 无需重载即生效。表单渲染链对 Config 的全部消费（已逐函数核实 dsh-settings
// 0.1.7-alpha.2 lib/index.js）：
//   volatileForm(schema)  → 读 schema.meta.volatile / .type / .dict，重建走
//                           new z(schema.toJSON())（z 接受 refs JSON，已实测）
//   applyPathOp/isVolatilePath → 读 schema.meta.default / .dict / .inner
//   cordis resolveConfig  → Config['~standard'].validate(config)
//   老 dsh settings resolve（provider/document 模型）→ schema(mergedValue) 调用
// 因此一个「schemastery 同构的鸭子 schema」（纯数据节点 + toJSON + validate +
// callable）即可被设置面板/热编辑/cordis 校验同时消费 —— preset 沙箱无法 import
// schemastery（相对解析根只有 preset 目录），鸭子形态是零依赖的唯一路径。
// 字段一律标 volatile：三读数都要「改完立即影响下一次调度」，不重载。

let DUCK_UID = 1

/**
 * 递归把鸭子节点转成 schemastery refs JSON（toJSON 输出）。
 * schemastery 的 refs 表是【扁平 uid 编号】形态：dict/list/inner 的子节点不内联，
 * 而是各自占一个 uid、以 uid 数字引用。z() 按此形态重建（已实测）。
 */
function duckToJSON(node) {
  const refs = {}
  const walk = (n) => {
    const out = { type: n.type, meta: n.meta || {} }
    if (n.value !== undefined) out.value = n.value
    if (n.dict) {
      out.dict = {}
      for (const k of Object.keys(n.dict)) out.dict[k] = walk(n.dict[k])
    }
    if (n.inner) out.inner = walk(n.inner)
    if (n.list) out.list = n.list.map(walk)
    const uid = DUCK_UID++
    refs[uid] = out
    return uid
  }
  const uid = walk(node)
  return { uid: uid, refs: refs }
}

/** 鸭子 validate：与 schemastery 输出兼容（{value} | {issues}），覆盖本插件用到的类型。 */
function duckValidateNode(node, value) {
  if (node.type === 'object') {
    if (value === undefined || value === null) return { value: (node.meta && node.meta.default) || {} }
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { issues: [{ message: 'expected an object' }] }
    }
    const out = {}
    let issues = null
    for (const k of Object.keys(node.dict || {})) {
      const has = Object.prototype.hasOwnProperty.call(value, k) && value[k] !== undefined
      const r = duckValidateNode(node.dict[k], has ? value[k] : undefined)
      if (r.issues) {
        issues = issues || []
        for (const i of r.issues) issues.push({ message: '$.' + k + ' ' + i.message, path: [k].concat(i.path || []) })
      } else if (r.value !== undefined) out[k] = r.value
    }
    return issues ? { issues: issues } : { value: out }
  }
  if (node.type === 'union') {
    // undefined（未提供）→ 回落到 union 的默认值；这与 schemastery 的 default 语义一致。
    if (value === undefined) return { value: node.meta && node.meta.default }
    for (const child of node.list || []) {
      const r = duckValidateNode(child, value)
      if (!r.issues) return r
    }
    const expected = (node.list || []).map(function (c) { return JSON.stringify(c.value) }).join(' | ')
    return { issues: [{ message: 'expected ' + expected + ' but got ' + JSON.stringify(value) }] }
  }
  if (node.type === 'const') {
    return node.value === value || (value === undefined && !node.meta.required)
      ? { value: node.value }
      : { issues: [{ message: 'expected ' + JSON.stringify(node.value) }] }
  }
  if (node.type === 'string') {
    if (value === undefined || value === null) value = node.meta && node.meta.default
    if (value === undefined) return node.meta && node.meta.required ? { issues: [{ message: 'expected a string' }] } : { value: value }
    if (typeof value !== 'string') return { issues: [{ message: 'expected a string but got ' + typeof value }] }
    return { value: value }
  }
  if (node.type === 'boolean') {
    if (value === undefined) value = node.meta && node.meta.default
    if (typeof value !== 'boolean') return { issues: [{ message: 'expected a boolean' }] }
    return { value: value }
  }
  if (node.type === 'number') {
    if (value === undefined) value = node.meta && node.meta.default
    if (typeof value !== 'number' || !Number.isFinite(value)) return { issues: [{ message: 'expected a number' }] }
    return { value: value }
  }
  return { value: value }
}

/** 鸭子节点工厂：callable（老 settings resolve 用）+ 实例数据面 + toJSON + ~standard。 */
function duckNode(node) {
  const schema = function (value) {
    const r = duckValidateNode(node, value)
    if (r.issues) throw new Error('config validation failed: ' + r.issues.map(function (i) { return i.message }).join('; '))
    return r.value
  }
  schema.type = node.type
  schema.meta = node.meta || {}
  if (node.value !== undefined) schema.value = node.value
  if (node.dict) { schema.dict = node.dict; for (const k of Object.keys(node.dict)) node.dict[k] = duckNode(node.dict[k]) }
  if (node.inner) schema.inner = duckNode(node.inner)
  if (node.list) { schema.list = node.list; for (let i = 0; i < node.list.length; i++) node.list[i] = duckNode(node.list[i]) }
  schema.toJSON = function () { return duckToJSON(node) }
  schema['~standard'] = { validate: function (value) { return duckValidateNode(node, value) } }
  return schema
}

/** 设置 schema 的鸭子构造入参（纯数据，schemastery 同构）。 */
function buildConfigDuck() {
  return {
    type: 'object',
    meta: { default: {} },
    dict: {
      preferredBackend: {
        type: 'union',
        meta: { default: DEFAULT_BACKEND, volatile: true, description: '优先使用的 CLI：新会话（调用未指定 backend 且无历史会话）默认调度到该后端。codebuddy=CodeBuddy 国内版（npm 包，product 端点 www.codebuddy.ai）；codebuddy-en=WorkBuddy AI 国际版（C:\\Program Files\\WorkBuddyAI 自带 CLI，product 端点 www.workbuddy.ai，需填 codebuddyEnToken）；workbuddy=WorkBuddy 国内版桌面自带 CLI（product 端点 copilot.tencent.com，免配置）。' },
        list: BACKENDS.map(function (b) { return { type: 'const', meta: { required: true }, value: b } })
      },
      defaultModel: {
        type: 'string',
        meta: { default: '', volatile: true, description: '默认模型（可选）：调用未显式指定 model 时注入 --model。留空 = 各 CLI 自己的默认。注意模型列表按产品面不同：国内 hy4-preview/hy3/glm-5.3 等；国际 auto/glm-5.1/kimi-k2.5 等。' }
      },
      codebuddyEnToken: {
        type: 'string',
        meta: { default: '', volatile: true, description: 'codebuddy-en（WorkBuddy AI 国际版）的登录凭据，注入为 CODEBUDDY_AUTH_TOKEN。国际版的登录 token 被桌面 App 的 protector key 加密，该密钥不落盘、headless CLI 无法自行读取（CLI 自身报 missing-key），所以必须在此提供。留空则 codebuddy-en 会以明确提示失败；国内版 codebuddy / workbuddy 无需填写。' }
      },
      endpointOverride: {
        type: 'string',
        meta: { default: '', volatile: true, description: '端点覆盖（可选，CODEBUDDY_BASE_URL，需含 /v2）。留空 = 按各后端登录域自动对齐端点（默认行为，通常无需修改）。仅当自动推导不正确时才填写，例如 https://www.codebuddy.cn/v2。' }
      }
    }
  }
}

/** 导出的插件 Config（鸭子 schema；见头注的设置面板投影论证）。 */
export const Config = duckNode(buildConfigDuck())

const CWD_FALLBACK = 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

// 设置值的运行时快照（apply 重入时整体重建；settings 变更通道写入后热重载）。
const settings = {
  preferredBackend: DEFAULT_BACKEND,
  defaultModel: '',
  codebuddyEnToken: '',
  endpointOverride: ''
}

function absorbSettings(config) {
  const c = config || {}
  if (typeof c.preferredBackend === 'string' && BACKENDS.indexOf(c.preferredBackend) >= 0) settings.preferredBackend = c.preferredBackend
  else settings.preferredBackend = DEFAULT_BACKEND
  settings.defaultModel = typeof c.defaultModel === 'string' ? c.defaultModel.trim() : ''
  settings.codebuddyEnToken = typeof c.codebuddyEnToken === 'string' ? c.codebuddyEnToken.trim() : ''
  settings.endpointOverride = typeof c.endpointOverride === 'string' ? c.endpointOverride.trim() : ''
}

// ── 登录域读取（v1.3.1，宿主侧 fs）───────────────────────────────────────────
// 端点必须与登录域一致，否则 CLI 报 401（实测：npm CLI 的 token 域是
// www.codebuddy.cn，product 端点却是 www.codebuddy.ai → 必然 401）。
// auth 库位置：%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<authentication.id>.info
// 三个产品面的 authentication.id 见 BACKEND_AUTH_IDS（取自各自 product.json）。
// 其中 auth.domain 三个文件**均为明文**，可直接读取 —— 无需解密 token 即可对齐端点。
// 读取失败一律返回 null（端点解析退化为「沿用 CLI 自身 product 端点」，不影响主流程）。
// CODEBUDDY_AUTH_DIR 可覆盖（测试夹具目录，使用例与真机登录状态解耦）。
function authDir() {
  return process.env.CODEBUDDY_AUTH_DIR || (process.env.LOCALAPPDATA || 'C:\\Users\\lcl\\AppData\\Local') + '\\CodeBuddyExtension\\Data\\Public\\auth'
}

function readAuthDomain(backend) {
  const id = BACKEND_AUTH_IDS[backend]
  if (!id) return null
  try {
    const raw = JSON.parse(readFileSync(authDir() + '\\' + id + '.info', 'utf8'))
    const d = raw && raw.auth && raw.auth.domain
    return typeof d === 'string' && d.trim() ? d.trim() : null
  } catch (e) { return null }
}

export function apply(ctx, config) {
  absorbSettings(config)
  // 旧 DSH 兼容通道：ctx.settings 存在且是 provider/document 模型（有 register()）
  // 时，注册本插件的 namespace，用户层改动通过 watch 同步进运行时快照。
  // 新 DSH 走 Config 投影（无需此通道）；两层并存时 watch 只在用户改 document 时触发，
  // 与行 config 热重载幂等（absorbSettings 全量覆盖）。
  try {
    const st = ctx.get ? ctx.get('settings') : undefined
    if (st && typeof st.register === 'function') {
      const scope = st.register('codebuddy-bridge', Config, { base: config || {} })
      if (scope && typeof scope.watch === 'function') {
        scope.watch(function (value) { absorbSettings(value) })
      }
      if (scope && typeof scope.get === 'function') absorbSettings(scope.get())
    }
  } catch (e) { /* 无 settings 服务 / namespace 冲突：静默降级为行 config。 */ }

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
  // 三个后端各有**独立安装包**（v1.3.0 的「国际版复用同一 npm CLI」已被实测推翻，
  // 见 docs/ROOT-CAUSE-codebuddy-en.md）：
  //   codebuddy    npm 全局包 @tencent-ai/codebuddy-code（productName "CodeBuddy"）。
  //                PATH → CODEBUDDY_BIN → npm 全局 bin（.cmd shim 走 node+bin，
  //                规避 CVE-2024-27980 后 spawn .cmd/.bat 的 EINVAL）。
  //   codebuddy-en WorkBuddy AI 国际版自带 CLI（productName "WorkBuddy AI"）。
  //                CODEBUDDY_EN_BIN → C:\Program Files\WorkBuddyAI\...
  //   workbuddy    WorkBuddy 国内版桌面自带 CLI（productName "WorkBuddy"）。
  //                WORKBUDDY_BIN → C:\Program Files\WorkBuddy\...
  // 三者同引擎同协议（stream-json/-p/--permission-mode），只是产品面与登录域不同。
  // 明确报错而不跨面回退：各产品面登录互斥，混用会污染同一会话存储。
  async function resolveExe(backend, execSignal) {
    const nodeExe = process.execPath || 'node'
    if (backend === 'workbuddy') {
      const wbBin = process.env.WORKBUDDY_BIN || 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
      return [nodeExe, wbBin]
    }
    if (backend === 'codebuddy-en') {
      const enBin = process.env.CODEBUDDY_EN_BIN || 'C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
      return [nodeExe, enBin]
    }
    try {
      const exe = await subprocess.resolveExecutable('codebuddy', undefined, execSignal)
      // npm 安装的 codebuddy 只有 .cmd shim，Node 直接 spawn .cmd/.bat 会 EINVAL
      // （CVE-2024-27980 加固后）；命中 .cmd/.bat 时改走 node + bin 脚本。
      if (!/\.(cmd|bat)$/i.test(exe)) return exe
    } catch (e) {}
    // 回退：node 直接跑 npm 全局 bin 脚本（codebuddy 通常不在 DSH 进程 PATH 里）。
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
    defaultMode: 'auto',
    // 设置面板 → 每次调用的三读数（v1.3.0）。getter 形式保证 settings watch / 行
    // config 热重载后立即生效，无需重建 runner。
    getPreferredBackend: function () { return settings.preferredBackend },
    getDefaultModel: function () { return settings.defaultModel },
    // 端点/凭据（v1.3.1）：端点覆盖 > 登录域推导；凭据仅 codebuddy-en 需要。
    getEndpointOverride: function () { return settings.endpointOverride },
    getAuthDomain: function (backend) { return readAuthDomain(backend) },
    getAuthToken: function (backend) { return backend === 'codebuddy-en' ? settings.codebuddyEnToken : null }
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
        backend: { type: 'string', enum: ['codebuddy', 'codebuddy-en', 'workbuddy'], description: 'Which CLI face to dispatch to. codebuddy (default; domestic CodeBuddy, copilot.tencent.com) for coding work; codebuddy-en (WorkBuddy AI international desktop bundled CLI); workbuddy (WorkBuddy desktop bundled CLI, international face — office scenarios: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies). New calls without a backend follow the user-preferred default backend (plugin settings). Continuing a session routes back to its owning backend automatically.' },
        mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits. Default auto.' },
        model: { type: 'string', description: 'Optional model id. When unspecified, the user-preferred default model (plugin settings) is used if set, else the CLI default. Model lists differ per backend — domestic (codebuddy): hy4-preview, hy3, hy3-x, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.7, kimi-k2.6, deepseek-v4-pro, deepseek-v4-flash; international (codebuddy-en/workbuddy): auto, glm-5v-turbo, glm-5.1, glm-5.0-turbo, glm-5.0, glm-4.7, kimi-k2.5, minimax-m2.7, deepseek-v3-2-volc. Pass a model only when the task clearly benefits from a specific one.' },
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
        backend: { type: 'string', enum: ['codebuddy', 'codebuddy-en', 'workbuddy'], description: 'Which CLI face to resume on. When omitted, the backend that owns the sessionId is used automatically; brand-new conversations follow the user-preferred default backend (plugin settings).' },
        mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode; default auto.' },
        model: { type: 'string', description: 'Optional model id (lists differ per backend — see codebuddy_run).' },
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
