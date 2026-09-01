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
    // workbuddy：WorkBuddy 桌面版自带 CLI（与 codebuddy 同引擎同协议）。
    async function resolveExe(backend, execSignal) {
      let nodeExe = 'node'
      try { nodeExe = await subprocess.resolveExecutable('node', undefined, execSignal) } catch (e) {}
      if (backend === 'workbuddy') {
        return [nodeExe, 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy']
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
      defaultMode: 'auto'
    })
    const coreExecute = runner.coreExecute

    // Client 可经包私有 JSON 方法读取快照。
    harness.handle('codebuddy_status', function () { return engine.statusSnapshot() })

    const OUT = { schema: { type: 'object', additionalProperties: true }, render: renderResult }
    const STATUS_OUT = { schema: { type: 'object', additionalProperties: true }, render: renderStatus }

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_run', description: 'Dispatch a coding/build/debug/investigation task to the local codebuddy agent CLI and return its final answer. DSH fully controls codebuddy (--permission-mode bypassPermissions; codebuddy never prompts). On rate-limit/network failure DSH pops a fallback dialog; fallback=true means finish with native tools. background=true returns a jobId. While it runs, call codebuddy_status to watch what codebuddy is doing live.', parameters: { prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.', required: true }, backend: { type: 'string', enum: ['codebuddy', 'workbuddy'], description: 'Which local CLI to dispatch to. codebuddy (default) for coding work; workbuddy (Tencent WorkBuddy, same engine, office-scenario product face) for office tasks: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies.' }, mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits.' }, model: { type: 'string', description: 'Optional codebuddy model id.' }, effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' }, maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500).' }, cwd: { type: 'string', description: 'Working directory for codebuddy.' }, addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to codebuddy workspace.' }, timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' }, background: { type: 'boolean', description: 'Run as a background job and return a jobId.' } }, output: OUT, execute: function (args, exec) { return coreExecute(args, exec) } }))

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_continue', description: 'Continue an existing codebuddy conversation with a follow-up prompt. Pass sessionId or set latest=true. Same DSH-controlled, no-prompt execution and same fallback dialog as codebuddy_run.', parameters: { prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codebuddy conversation.', required: true }, sessionId: { type: 'string', description: 'codebuddy session id to resume.' }, latest: { type: 'boolean', description: 'Continue the most recent codebuddy conversation.' }, backend: { type: 'string', enum: ['codebuddy', 'workbuddy'], description: 'Which CLI to resume on; defaults to the backend owning the sessionId.' }, mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode.' }, model: { type: 'string', description: 'Optional codebuddy model id.' }, effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' }, maxTurns: { type: 'integer', description: 'Optional max agentic turns.' }, cwd: { type: 'string', description: "Working directory for codebuddy; when resuming, defaults to the resumed session's project directory." }, timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' }, background: { type: 'boolean', description: 'Run as a background job and return a jobId.' } }, output: OUT, execute: function (args, exec) { const a = args || {}; const mapped = { prompt: a.prompt, backend: a.backend, mode: a.mode, model: a.model, effort: a.effort, maxTurns: a.maxTurns, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background }; if (a.sessionId) mapped.sessionId = a.sessionId; else if (a.latest) mapped.continueLatest = true; return coreExecute(mapped, exec) } }))

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_status', description: 'Read a live snapshot of what the local codebuddy agent is currently doing. Returns one section per project (working directory): running count, current step (tool name + arguments being executed, or agent_response thinking/typing), recent step trail, last completed run status + session id, and per-project cumulative usage (runs + total tokens, since codebuddy exposes no quota API). Call this to check on an in-flight codebuddy_run/codebuddy_continue without waiting for it to finish.', parameters: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } }, output: STATUS_OUT, execute: function (args) { const a = args || {}; const snap = engine.statusSnapshot(); if (a.cwd) { const key = String(a.cwd); snap.projects = snap.projects.filter(function (p) { return p.cwd === key }); const g = snap.projects[0]; if (g) { snap.state = g.state; snap.running = g.running; snap.current = g.current; snap.trail = g.trail; snap.lastStatus = g.lastStatus; snap.lastAt = g.lastAt; snap.lastSessionId = g.lastSessionId; snap.lastBackend = g.lastBackend; snap.fallbackActive = g.fallbackActive; snap.runs = g.runs; snap.totalTokens = g.totalTokens; snap.updatedAt = g.updatedAt } } return snap } }))

    ctx.systemPrompt.section({ name: 'codebuddy:policy', order: 5, text: POLICY_TEXT })
  }
}
