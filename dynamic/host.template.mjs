// dynamic/host.js — 【生成文件，勿手改】
// 由 scripts/build.mjs 从本模板（dynamic/host.template.mjs）+
// core/codebuddy-core.mjs 拼装生成。修改共享逻辑 → 改 core；修改动态适配 →
// 改本模板；然后 `node scripts/build.mjs` 重新生成并提交。
//
// Cordis 动态插件沙箱禁止 import/require，故共享核心以文本注入到本文件中
// 段的 CORE 占位标记处（见下方独立一行的标记）。
// 沙箱内无 process/env/ctx.emit：node 可执行文件经 subprocess.resolveExecutable
// 解析，状态经家级收集器（codebuddyCollector.mergeSnapshot）汇入状态灯。
/*__CORE__*/

const CWD_FALLBACK = 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'

// 设置读数（动态形态无 Config 声明面）：v1.3.2 起统一走 core 的 readBridgeSettingsFile
// （与 preset 设置面板写入的 dsh-home/codebuddy-bridge-settings.json 同一份、同一实现）。
// 返回 null = 文件缺失/无法定位 → 用 defaultBridgeSettings()。
// 沙箱约束：new Function 求值 → 不可用 import.meta；dsh-home 定位靠 DSH_HOME。
const applySettings = readBridgeSettingsFile() || defaultBridgeSettings()

// 登录域读取（v1.3.1）：端点必须与登录域一致，否则 CLI 报 401。auth 库的
// auth.domain 是明文，无需解密 token。位置：
// %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<authentication.id>.info
// 读取失败返回 null → 端点解析退化为「沿用 CLI 自身 product 端点」。
function readAuthDomain(backend) {
  const id = BACKEND_AUTH_IDS[backend]
  if (!id) return null
  try {
    const proc = globalThis.process
    const nodeFs = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:fs') : null
    const nodePath = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:path') : null
    if (!nodeFs || !nodePath) return null
    // CODEBUDDY_AUTH_DIR 可覆盖（测试夹具目录，使用例与真机登录状态解耦）。
    const local = (proc.env && proc.env.CODEBUDDY_AUTH_DIR) ||
      nodePath.join((proc.env && proc.env.LOCALAPPDATA) || 'C:\\Users\\lcl\\AppData\\Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    const p = nodePath.join(local, id + '.info')
    const raw = JSON.parse(nodeFs.readFileSync(p, 'utf8'))
    const d = raw && raw.auth && raw.auth.domain
    return typeof d === 'string' && d.trim() ? d.trim() : null
  } catch (e) { return null }
}

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

    // 沙箱内无 process/env：node 经 subprocess 解析；bin 路径为固定回退。
    // 三个后端各有独立安装包（v1.3.0 的「国际版复用同一 npm CLI」已实测推翻）：
    //   codebuddy    npm 全局包 @tencent-ai/codebuddy-code
    //   codebuddy-en WorkBuddy AI 国际版自带 CLI（C:\Program Files\WorkBuddyAI）
    //   workbuddy    WorkBuddy 国内版桌面自带 CLI（C:\Program Files\WorkBuddy）
    async function resolveExe(backend, execSignal) {
      let nodeExe = 'node'
      try { nodeExe = await subprocess.resolveExecutable('node', undefined, execSignal) } catch (e) {}
      if (backend === 'workbuddy') {
        return [nodeExe, 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy']
      }
      if (backend === 'codebuddy-en') {
        return [nodeExe, 'C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy']
      }
      try {
        const exe = await subprocess.resolveExecutable('codebuddy', undefined, execSignal)
        // npm 安装的 codebuddy 只有 .cmd shim，Node 直接 spawn .cmd/.bat 会 EINVAL
        // （CVE-2024-27980 加固后）；命中 .cmd/.bat 时改走 node + bin 脚本。
        if (!/\.(cmd|bat)$/i.test(exe)) return exe
      } catch (e) {}
      return [nodeExe, 'C:\\Users\\lcl\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy']
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
      // v1.3.2 可视化配置界面：getter 每次现读设置文件（面板经 POST 写入），缺失
      // 才回退 apply 时快照 —— 面板保存即时生效，无需重载插件。
      getPreferredBackend: function () { const f = readBridgeSettingsFile(); return f ? f.preferredBackend : applySettings.preferredBackend },
      getDefaultModel: function () { const f = readBridgeSettingsFile(); return f ? f.defaultModel : applySettings.defaultModel },
      // 端点/凭据（v1.3.1）：端点覆盖 > 登录域推导；凭据仅 codebuddy-en 需要。
      getEndpointOverride: function () { const f = readBridgeSettingsFile(); return f ? f.endpointOverride : applySettings.endpointOverride },
      getAuthDomain: function (backend) { return readAuthDomain(backend) },
      getAuthToken: function (backend) { const f = readBridgeSettingsFile(); return backend === 'codebuddy-en' ? (f ? f.codebuddyEnToken : applySettings.codebuddyEnToken) : null }
    })
    const coreExecute = runner.coreExecute

    // Client 可经包私有 JSON 方法读取快照。
    harness.handle('codebuddy_status', function () { return engine.statusSnapshot() })

    const OUT = { schema: { type: 'object', additionalProperties: true }, render: renderResult }
    const STATUS_OUT = { schema: { type: 'object', additionalProperties: true }, render: renderStatus }

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_run', description: 'Dispatch a coding/build/debug/investigation task to the local codebuddy agent CLI and return its final answer. DSH fully controls codebuddy (--permission-mode bypassPermissions; codebuddy never prompts). On rate-limit/network failure DSH pops a fallback dialog; fallback=true means finish with native tools. background=true returns a jobId. While it runs, call codebuddy_status to watch what codebuddy is doing live.', parameters: { prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.', required: true }, backend: { type: 'string', enum: ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy'], description: 'Which CLI face to dispatch to. codebuddy (default; domestic CodeBuddy npm CLI, product endpoint www.codebuddy.ai) for coding work; codebuddy-intl = CodeBuddy INTERNATIONAL face of the same npm CLI (product.ioa.json catalogue: claude-sonnet-5 / claude-opus-5 / gemini-3.1-pro / gpt-6-astra / hy3-ioa ...; aliases codebuddy-ioa / codebuddy-international) when the account is an international CodeBuddy account; codebuddy-en = WorkBuddy international edition (WorkBuddyAI desktop bundled CLI at C:\\Program Files\\WorkBuddyAI, product endpoint www.workbuddy.ai; aliases workbuddy-en / workbuddy-ai accepted; needs codebuddyEnToken unless DSH already holds a workbuddy key); workbuddy = WorkBuddy domestic desktop CLI (product endpoint copilot.tencent.com, zero config), the office-scenario face: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies. New calls without a backend follow the user-preferred default backend (plugin settings). Continuing a session routes back to its owning backend automatically.' }, mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits.' }, model: { type: 'string', description: 'Optional model id. When unspecified, the user-preferred default model (plugin settings) is used if set, else the CLI default. Two layers decide: the PRODUCT FACE decides whether the id exists in its catalogue, then the ACCOUNT decides whether it is licensed. The free tier (hy3, deepseek-v4.1-flash at x0.00 credits; hy4-preview at x0.29) belongs to the npm CLI faces codebuddy/codebuddy-intl: hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, deepseek-v4-pro. codebuddy-en (WorkBuddyAI) carries NO hy4-preview and NO deepseek-v4.1-flash; its only free model is hy3. International ids (claude-sonnet-5, gemini-3.1-pro, ...) are account-gated. Pass a model only when the task clearly benefits from a specific one.' }, effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' }, maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500).' }, cwd: { type: 'string', description: 'Working directory for codebuddy.' }, addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to codebuddy workspace.' }, timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' }, background: { type: 'boolean', description: 'Run as a background job and return a jobId.' } }, output: OUT, execute: function (args, exec) { return coreExecute(args, exec) } }))

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_continue', description: 'Continue an existing codebuddy conversation with a follow-up prompt. Pass sessionId or set latest=true. Same DSH-controlled, no-prompt execution and same fallback dialog as codebuddy_run.', parameters: { prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codebuddy conversation.', required: true }, sessionId: { type: 'string', description: 'codebuddy session id to resume.' }, latest: { type: 'boolean', description: 'Continue the most recent codebuddy conversation.' }, backend: { type: 'string', enum: ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy'], description: 'Which CLI face to resume on. codebuddy-en = WorkBuddy international (WorkBuddyAI desktop CLI; aliases workbuddy-en / workbuddy-ai accepted), workbuddy = WorkBuddy domestic desktop CLI. When omitted, the backend that owns the sessionId is used automatically; brand-new conversations follow the user-preferred default backend (plugin settings).' }, mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode.' }, model: { type: 'string', description: 'Optional model id (two layers: product face carries it, account licenses it — see codebuddy_run).' }, effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' }, maxTurns: { type: 'integer', description: 'Optional max agentic turns.' }, cwd: { type: 'string', description: "Working directory for codebuddy; when resuming, defaults to the resumed session's project directory." }, timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' }, background: { type: 'boolean', description: 'Run as a background job and return a jobId.' } }, output: OUT, execute: function (args, exec) { const a = args || {}; const mapped = { prompt: a.prompt, backend: a.backend, mode: a.mode, model: a.model, effort: a.effort, maxTurns: a.maxTurns, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background }; if (a.sessionId) mapped.sessionId = a.sessionId; else if (a.latest) mapped.continueLatest = true; return coreExecute(mapped, exec) } }))

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_status', description: 'Read a live snapshot of what the local codebuddy agent is currently doing. Returns one section per project (working directory): running count, current step (tool name + arguments being executed, or agent_response thinking/typing), recent step trail, last completed run status + session id, and per-project cumulative usage (runs + total tokens, since codebuddy exposes no quota API). Call this to check on an in-flight codebuddy_run/codebuddy_continue without waiting for it to finish.', parameters: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } }, output: STATUS_OUT, execute: function (args) { const a = args || {}; const snap = engine.statusSnapshot(); if (a.cwd) { const key = String(a.cwd); snap.projects = snap.projects.filter(function (p) { return p.cwd === key }); const g = snap.projects[0]; if (g) { snap.state = g.state; snap.running = g.running; snap.current = g.current; snap.trail = g.trail; snap.lastStatus = g.lastStatus; snap.lastAt = g.lastAt; snap.lastSessionId = g.lastSessionId; snap.lastBackend = g.lastBackend; snap.fallbackActive = g.fallbackActive; snap.runs = g.runs; snap.totalTokens = g.totalTokens; snap.updatedAt = g.updatedAt } } return snap } }))

    ctx.systemPrompt.section({ name: 'codebuddy:policy', order: 5, text: POLICY_TEXT })
  }
}