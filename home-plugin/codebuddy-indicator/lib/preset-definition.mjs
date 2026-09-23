// preset-definition.mjs — codebuddy-first preset 的「声明式注册」定义（v1.2.0）。
//
// ── 背景（为什么这个文件存在）──────────────────────────────────────────────
// 旧 DSH（≤ 0.1.6-alpha.2）的 Form-A 交付形态是目录式 preset：把 preset/ 安装到
// `$DSH_HOME/.agent-presets/<id>/`（preset.yml + agent.cordis.yml），dsh 启动时
// 逐目录读取。0.1.7-alpha.1 起该机制被**声明制**取代：preset 由插件在运行时向
// `agentPresets` 注册表登记（官方标准 preset 即 dsh-web-app bundle patch 里的
// `@deepseek-ai/dsh-agent-preset` 声明行），旧目录在新 DSH 上**永远不会被读取**
// ——Form-A 在 ≥0.1.7-alpha.1 上静默失效（v1.2.0 修复的根因）。
//
// ── 注册通道（为什么走 indicator 而不是新增声明行）────────────────────────
// 声明行的标准通道是 `@deepseek-ai/dsh-agent-preset` 插件，但它是 0.1.7-alpha.1
// 才出现的包：旧 DSH 的 loader（1.0.3）对导入失败是**致命**的（Entry._init 重抛 +
// EntryGroup.update 单失败即抛），任何「按版本条件加载声明行」的写法都会把旧
// DSH 的整棵 profile 树炸掉。因此改为复用已经全版本可加载的 indicator 插件
// （裸包名主入口，26 个 dsh 版本回测通过）：apply 里 `ctx.inject(['agentPresets'],
// …)` 等待注册表服务——旧 DSH 上该服务永不出现，注入器永远挂起（cordis 语义：
// 等待中的注入器不是失败，loader 不等待它）；新 DSH 上回调触发，调用
// `agentPresets.register(definition)` 完成注册。与官方注册表内部等待 `settings`
// 服务是同一模式。
//
// ── plugins 组合（与官方 standard.patch.yml 的关系）────────────────────────
// plugins 是官方 standard preset（dsh-web-app/presets/standard.patch.yml，0.1.7-rc.1）
// 的忠实移植：行序、id、config 逐项一致，仅两处差异——
//   1. 末尾追加 codebuddy-first-bridge 桥接行（本插件的全部增量）；
//   2. YAML 的 `!!js` 表达式改写为等价的 `{ __jsExpr: "…" }` 字面量（loader 的
//      interpolate 对两者一视同仁，见 cordis-plugin-loader lib/index.js）。
// 桥接行 name 用**裸说明符 + 子路径导出** `codebuddy-first-bridge/preset-bridge`
// （package.json exports）而非相对路径：registry 挂载 preset 时以**注册表自己的
// baseUrl**（dsh-web-app 包目录）解析相对名，相对路径必然指错；裸说明符走
// ResolutionRouter 的 profile 包图路由——与官方 preset 行
// `@deepseek-ai/dsh-tool-subagent-control/list-agents`（子路径、非 disabled）同机制。
//
// 换行注意：preset 组合服务（isolate realm）会拒绝泄漏的服务，本组合的行全部
// 只注册工具/命令/prompt 段，无服务提供者，可直接挂载。
//
// drift 防护：test/preset-declaration.test.mjs 在装有 dsh 的机器上会把本定义与
// 已安装 dsh-web-app 的 standard.patch.yml 逐行比对（行序 id + `!!js` 计数 +
// 关键 config 标量 + plan-mode 全文），防止上游改版后移植漂移。

/** preset id：与 indicator 的 PRESET_ID（状态灯会话判定）严格一致。 */
export const PRESET_ID = 'codebuddy-first'

/** 声明行的合成 id（roster / 会话日志展示用）。 */
export const PRESET_DECLARATION_ID = 'preset-codebuddy-first'

/** 桥接行的裸说明符（经 package.json exports["./preset-bridge"] 解析）。 */
export const PRESET_BRIDGE_SPECIFIER = 'codebuddy-first-bridge/preset-bridge'

/** 本 preset 在 roster 中的排序：官方 standard=1 / ptc=2 / minimal=3 / cordis=4 之后。 */
export const PRESET_ORDER = 10

/** YAML `!!js expr` 的 JS 字面量等价物（loader interpolate 的原生输入形态）。 */
function jsExpr(expr) {
  return { __jsExpr: expr }
}

// 官方 standard preset 的 plan-mode 段全文（0.1.7-rc.1，块标量内容，段间双换行）。
// 单独提出便于测试与上游逐字比对。
export const PLAN_MODE_SECTION = [
  'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user\'s conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.',
  'Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.',
  'The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.',
  'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.',
  'Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.',
  'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.',
].join('\n\n') + '\n'

/**
 * 组装 preset 定义（plugins 行表与官方 standard.patch.yml 0.1.7-rc.1 逐项对齐）。
 * @param {string} [bridgeName] 桥接行 name（默认裸说明符；测试可注入 file:// 形态）。
 * @returns {{ id, name, description, order, plugins }} agentPresets.register 的入参。
 */
export function buildPresetDefinition(bridgeName) {
  const bridge = bridgeName || PRESET_BRIDGE_SPECIFIER
  return {
    id: PRESET_ID,
    name: 'CodeBuddy-First 执行代理',
    description:
      '完整编码 Agent（standard 全部能力），额外提供 codebuddy_run/codebuddy_continue 工具并注入' +
      '"codebuddy 优先"策略：各种模式下先把实现、编辑、调试、构建、跨文件排查派给本机 codebuddy CLI' +
      '（DSH 完全控制、codebuddy 无提示改文件），原生工具仅用于只读查询与最终验证。',
    order: PRESET_ORDER,
    plugins: [
      // ── 以下至 bridge 行 = 官方 standard.patch.yml 的忠实移植 ──
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
        suffix: 'Your working directory is {{cwd}}.',
        prefix: 'You are a coding agent powered by the {{model}} model.',
      } },
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: jsExpr("process.platform === 'win32'") },
      { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: jsExpr("process.platform !== 'win32'") },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
      { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
      { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
      { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
      { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
      {
        id: 'planning', name: 'cordis:group', group: true,
        isolate: { planMode: true },
        config: [
          { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: { section: PLAN_MODE_SECTION } },
        ],
      },
      {
        id: 'compaction', name: 'cordis:group', group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
          { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: {
            thresholdChars: 8192, headChars: 4096, tailChars: 1024,
          } },
        ],
      },
      {
        id: 'delegation', name: 'cordis:group', group: true,
        isolate: { workflowEngine: true },
        config: [
          { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
          { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
          { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: {
            provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true, backgroundMode: 'continuable',
          } },
          { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: {
            provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable',
          } },
          { id: 'tool-subagent-codex', name: '@deepseek-ai/dsh-tool-subagent', disabled: true, config: {
            provider: 'codex', toolName: 'subagent_codex', backgroundMode: 'one-shot', maxDepth: 'provider-managed',
          } },
          { id: 'tool-subagent-claude-code', name: '@deepseek-ai/dsh-tool-subagent', disabled: true, config: {
            provider: 'claude-code', toolName: 'subagent_claude_code', backgroundMode: 'one-shot', maxDepth: 'provider-managed',
          } },
          { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
          { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
          { id: 'tool-ralph', name: '@deepseek-ai/dsh-tool-ralph', disabled: true, config: {
            subagentProvider: 'spawn', maxRounds: 64,
          } },
        ],
      },
      { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
      { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
      { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
      { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true },
      // ── 本插件增量：codebuddy 桥接行（相对 ./codebuddy-core.mjs 自包含） ──
      { id: 'codebuddy-first-bridge', name: bridge },
    ],
  }
}

/**
 * 从本模块位置推导桥接入口模块的绝对 file:// URL（布局自检用；默认走裸说明符，
 * 该函数供测试与降级诊断验证包内相对布局 lib → 包根 → preset/ 是否完好）。
 * @param {string} [moduleUrl] 基准模块 URL（默认 import.meta.url）。
 * @returns {string} preset/codebuddy-first/codebuddy-first-bridge.mjs 的 file:// URL。
 */
export function bridgeEntryUrl(moduleUrl) {
  return new URL('../../../preset/codebuddy-first/codebuddy-first-bridge.mjs', moduleUrl || import.meta.url).href
}

/**
 * 在 ctx（indicator 的宿主上下文）上挂「agentPresets 就绪 → 注册 preset」等待器。
 *
 * - 新 DSH（≥0.1.7-alpha.1）：agentPresets 注册表服务出现后触发，注册本定义并
 *   把 register() 返回的注销 disposer 登记为 effect 清理（随插件卸载）。
 * - 旧 DSH：agentPresets 永不出现，注入器保持挂起（cordis 语义：等待不是失败，
 *   loader 不收集挂起注入器），无任何副作用。
 * - 重复 id / 注册表拒绝：捕获并 logger.warn，不允许把故障抛回宿主树。
 *
 * @param {object} ctx indicator apply 的 ctx（需支持 ctx.inject；child 需 effect）。
 * @returns {boolean} 是否成功挂上等待器（ctx.inject 缺失时 false，不抛错）。
 */
export function declareCodebuddyFirstPreset(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return false
  ctx.inject(['agentPresets'], (child) => {
    child.effect(() => {
      let disposer = null
      const registering = (async () => {
        try {
          disposer = await child.agentPresets.register(buildPresetDefinition())
        } catch (error) {
          // 重复注册（双实例/用户手工声明行撞 id）等：roster 里看到的是官方或
          // 手工那份；本份注册放弃即可，绝不向宿主树抛错。
          try {
            if (child.logger && typeof child.logger.warn === 'function') {
              child.logger.warn(`codebuddy-first: agent preset registration skipped: ${error && error.message || error}`)
            }
          } catch (_) { /* 日志通道不可用则静默 */ }
        }
      })()
      return async () => {
        try { await registering } catch (_) { /* setup 已在内部消化 */ }
        if (typeof disposer === 'function') {
          try { await disposer() } catch (_) { /* 注销失败不阻断卸载 */ }
        }
        disposer = null
      }
    }, 'codebuddy-first-bridge: agent preset declaration')
  })
  return true
}
