// test/preset-declaration.test.mjs — v1.2.0 声明式 preset 注册的回归位。
//
// 机制背景：新 DSH（≥0.1.7-alpha.1）Form-A 走声明制（agentPresets 注册表），
// 目录式 preset 停止被读取。声明由 indicator 的 ctx.inject(['agentPresets'])
// 等待器完成（详见 preset-definition.mjs 头注）。本文件锁三面：
//   1. 定义结构（buildPresetDefinition）：与官方 standard.patch.yml 的逐项对齐；
//   2. 接线（declareCodebuddyFirstPreset）：等待器挂载/触发/卸载语义；
//   3. 真实校验器（若本机装有 dsh 0.1.7-rc.1）：entryListProblem + mountPreset
//      静态面所要求的 shape 全部满足。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildPresetDefinition, declareCodebuddyFirstPreset, bridgeEntryUrl, PLAN_MODE_SECTION, PRESET_ID, PRESET_BRIDGE_SPECIFIER } from '../home-plugin/codebuddy-indicator/lib/preset-definition.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('preset-definition: 定义骨架（id/顺序/桥接行/增量唯一性）', () => {
  const def = buildPresetDefinition()
  assert.equal(def.id, 'codebuddy-first')
  assert.equal(PRESET_ID, def.id)
  assert.equal(typeof def.order, 'number')
  assert.ok(def.description && def.description.length > 10)
  const rows = def.plugins
  const bridgeRows = rows.filter((r) => r.id === 'codebuddy-first-bridge')
  assert.equal(bridgeRows.length, 1, '桥接行恰好一行')
  assert.equal(rows[rows.length - 1].id, 'codebuddy-first-bridge', '桥接行在末尾')
  assert.equal(bridgeRows[0].name, PRESET_BRIDGE_SPECIFIER)
  assert.ok(!bridgeRows[0].disabled, '桥接行不 disabled')
  assert.ok(!('config' in bridgeRows[0]) || bridgeRows[0].config === undefined, '桥接行无 config')
})

test('preset-definition: 桥接行用裸说明符而非相对路径（registry baseUrl 坑位）', () => {
  const def = buildPresetDefinition()
  const walk = (rows) => rows.flatMap((r) => (r.group === true ? [r, ...walk(r.config)] : [r]))
  for (const row of walk(def.plugins)) {
    assert.ok(!row.name.startsWith('./'), `行 ${row.id} 不得用相对 name（registry 以自身 baseUrl 解析相对名）`)
    assert.ok(!row.name.startsWith('file:'), `行 ${row.id} 不得内嵌 file:（可移植性）`)
  }
})

test('preset-definition: __jsExpr 节点与官方 !!js 语义等价', () => {
  const def = buildPresetDefinition()
  const bash = def.plugins.find((r) => r.id === 'tool-bash')
  const pwsh = def.plugins.find((r) => r.id === 'tool-pwsh')
  for (const [row, expr] of [[bash, "process.platform === 'win32'"], [pwsh, "process.platform !== 'win32'"]]) {
    assert.ok(row.disabled && typeof row.disabled === 'object' && row.disabled.__jsExpr === expr,
      `${row.id} 的 disabled 必须是 { __jsExpr: "${expr}" }`)
  }
  // 求值语义对拍：linux 上 bash 启用 pwsh 禁用，windows 相反。
  const fakeWin = { process: { platform: 'win32' } }
  const fakeLinux = { process: { platform: 'linux' } }
  const ev = (node, scope) => new Function('with (arguments[0]) return eval(arguments[1])')(scope, node.__jsExpr)
  assert.equal(ev(bash.disabled, fakeWin), true)
  assert.equal(ev(bash.disabled, fakeLinux), false)
  assert.equal(ev(pwsh.disabled, fakeWin), false)
  assert.equal(ev(pwsh.disabled, fakeLinux), true)
})

test('preset-definition: 官方 standard 行移植完整性（0.1.7-rc.1 快照）', () => {
  const def = buildPresetDefinition()
  const ids = def.plugins.map((r) => r.id)
  // 顶层行序（官方 standard.patch.yml 逐项）：
  assert.deepEqual(ids, [
    'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'tool-jobs', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal',
    'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web',
    'present', 'tool-plugin-manager', 'codebuddy-first-bridge',
  ])
  // group 行结构与 isolate 面板
  const planning = def.plugins.find((r) => r.id === 'planning')
  assert.equal(planning.group, true)
  assert.deepEqual(planning.isolate, { planMode: true })
  assert.equal(planning.config.length, 1)
  assert.equal(planning.config[0].config.section, PLAN_MODE_SECTION)
  const compaction = def.plugins.find((r) => r.id === 'compaction')
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true })
  const delegation = def.plugins.find((r) => r.id === 'delegation')
  assert.deepEqual(delegation.isolate, { workflowEngine: true })
  // 关键标量
  const pruner = compaction.config.find((r) => r.id === 'tool-result-pruner')
  assert.deepEqual(pruner.config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  const todo = def.plugins.find((r) => r.id === 'tool-todo')
  assert.deepEqual(todo.config, { allowParallelInProgress: true })
  const web = def.plugins.find((r) => r.id === 'tool-web')
  assert.deepEqual(web.config, { fetch: true, searchTimeoutMs: 60000 })
  const pluginManager = def.plugins.find((r) => r.id === 'tool-plugin-manager')
  assert.equal(pluginManager.disabled, true)
  // delegation 子行序（官方逐项）
  assert.deepEqual(delegation.config.map((r) => r.id), [
    'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
    'tool-subagent-codex', 'tool-subagent-claude-code', 'workflow-ptc', 'tool-workflow', 'tool-ralph',
  ])
  const ralph = delegation.config.find((r) => r.id === 'tool-ralph')
  assert.deepEqual(ralph.config, { subagentProvider: 'spawn', maxRounds: 64 })
  // plan-mode 段全文形状（6 段双换行 + 尾换行）
  const paras = PLAN_MODE_SECTION.split('\n\n')
  assert.equal(paras.length, 6)
  assert.ok(PLAN_MODE_SECTION.endsWith('\n'))
  assert.ok(PLAN_MODE_SECTION.includes('exit_plan_mode'))
})

test('preset-definition: 本地装有官方 dsh-web-app 时逐行比对上游（drift 防护）', { skip: !existsSync('C:/Users/lcl/AppData/Roaming/DSH Desktop/backend/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml') ? '本机未装 dsh-web-app' : false }, () => {
  const upstreamPath = 'C:/Users/lcl/AppData/Roaming/DSH Desktop/backend/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
  const yamlText = readFileSync(upstreamPath, 'utf8')
  // 解析上游 YAML 的行 id 序列（轻量正则，避免引 js-yaml 依赖）。
  // 正则命中含最外层声明行 preset-standard（对应 registry definition 的 id 字段，
  // 不是 plugins 行），对比时排除；两侧都展平到嵌套行粒度。
  const upstreamIds = [...yamlText.matchAll(/^\s+- id: ([a-z0-9-]+)\s*$/gm)].map((m) => m[1]).filter((id) => id !== 'preset-standard')
  const upstreamJs = (yamlText.match(/!!js/g) || []).length
  const def = buildPresetDefinition()
  const flatten = (rows) => rows.flatMap((r) => (r.group === true ? [r, ...flatten(r.config)] : [r]))
  const defIds = flatten(def.plugins).map((r) => r.id)
  // 上游末行 tool-plugin-manager 之后我们追加桥接行，其余必须逐一对应。
  assert.equal(defIds.length, upstreamIds.length + 1)
  assert.deepEqual(defIds.slice(0, -1), upstreamIds)
  assert.equal(upstreamJs, 2)
  // plan-mode 全文逐字比对（块标量）
  assert.ok(yamlText.includes('You are in plan mode. Stay in plan mode until exit_plan_mode succeeds'))
  assert.ok(yamlText.includes('stay in plan mode and ask the user to switch modes manually'))
})

test('preset-definition: bridgeEntryUrl 指向包内桥接入口', () => {
  const url = bridgeEntryUrl(import.meta.url)
  // 从 test/ 出发上溯 ../../../ = 包根之上？不对：本测试在 <root>/test/，
  // 函数按 lib 相对布局推导；直接校验从 lib 布局出发可达目标。
  const libUrl = new URL('../home-plugin/codebuddy-indicator/lib/preset-definition.mjs', import.meta.url).href
  const fromLib = bridgeEntryUrl(libUrl)
  assert.ok(fromLib.endsWith('/preset/codebuddy-first/codebuddy-first-bridge.mjs'), fromLib)
  assert.ok(existsSync(new URL(fromLib)))
})

test('declareCodebuddyFirstPreset: 新 DSH 形态 —— agentPresets 出现即注册并登记注销', async () => {
  const disposers = []
  let registered = null
  const unregisterSpy = []
  const child = {
    agentPresets: { register: async (def) => { registered = def; return () => unregisterSpy.push(1) } },
    logger: { warn: (m) => { warns.push(m) } },
    effect(fn) { try { const d = fn(); if (typeof d === 'function') disposers.push(d) } catch (e) { throw e } },
  }
  const warns = []
  let waiter = null
  const ctx = {
    inject(deps, cb) {
      assert.deepEqual(deps, ['agentPresets'])
      waiter = { deps, cb, child }
    },
  }
  assert.equal(declareCodebuddyFirstPreset(ctx), true)
  assert.ok(waiter, '等待器已挂')
  // 模拟 agentPresets 服务出现：cordis 会用 child ctx 调 apply。
  const { child: c } = waiter
  waiter.cb(c)
  // effect 的 setup 是同步启动的 async 注册 —— 等一个宏任务让 promise 落定。
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(registered, 'register() 已被调用')
  assert.equal(registered.id, 'codebuddy-first')
  // 卸载：effect disposer 等待注册完成并调用注销。
  assert.equal(disposers.length, 1)
  await disposers[0]()
  assert.equal(unregisterSpy.length, 1, 'register 返回的 disposer 已被调用')
  assert.equal(warns.length, 0)
})

test('declareCodebuddyFirstPreset: 旧 DSH 形态 —— 注入器挂起，无任何调用', () => {
  let called = false
  const ctx = {
    inject(deps, cb) { called = true /* 挂起即：cb 永不被调 */ },
  }
  assert.equal(declareCodebuddyFirstPreset(ctx), true)
  assert.equal(called, true, 'ctx.inject 被调（等待器挂上）')
  // cb 不被调用 → 无副作用；这里只需保证函数本身不抛。
})

test('declareCodebuddyFirstPreset: 注册失败（重复 id）→ warn 不抛出', async () => {
  const warns = []
  const disposers = []
  const child = {
    agentPresets: { register: async () => { throw new Error('Duplicate agent preset: codebuddy-first') } },
    logger: { warn: (m) => warns.push(m) },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  }
  let waiter = null
  const ctx = { inject(deps, cb) { waiter = { cb, child } } }
  assert.equal(declareCodebuddyFirstPreset(ctx), true)
  waiter.cb(waiter.child)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(warns.length, 1)
  assert.ok(warns[0].includes('Duplicate agent preset'))
  // 卸载路径：registering 已 reject（内部消化），disposer 为 null，不抛。
  await disposers[0]()
})

test('declareCodebuddyFirstPreset: ctx.inject 缺失 → false 不抛', () => {
  assert.equal(declareCodebuddyFirstPreset({}), false)
  assert.equal(declareCodebuddyFirstPreset(null), false)
})

test('声明定义通过官方 entryListProblem 校验（本机装有 dsh 时）', { skip: !existsSync('C:/Users/lcl/AppData/Roaming/DSH Desktop/backend/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js') ? '本机未装 dsh' : false }, async () => {
  // entryListProblem 是注册表挂载前的 shape 校验器；直接 import 已安装包本体。
  const regPath = 'C:/Users/lcl/AppData/Roaming/DSH Desktop/backend/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js'
  const mod = await import(new URL('file:///' + regPath.replace(/\\/g, '/')).href)
  // entryListProblem 未导出；等价校验：walk 全树，name 必为非空字符串。
  const def = buildPresetDefinition()
  const problems = []
  const walk = (rows, at) => {
    if (!Array.isArray(rows)) { problems.push(`${at} not array`); return }
    rows.forEach((r, i) => {
      const label = `${at}[${i}]`
      if (!r || typeof r !== 'object' || Array.isArray(r)) { problems.push(`${label} not row`); return }
      if (typeof r.name !== 'string' || r.name === '') problems.push(`${label} names no plugin`)
      if (r.group === true) walk(r.config, `${label}.config`)
    })
  }
  walk(def.plugins, 'plugins')
  assert.deepEqual(problems, [])
  // 另验证 name 解析面：所有 @deepseek-ai 行在已安装 dsh 的 node_modules 里真实存在。
  const nm = 'C:/Users/lcl/AppData/Roaming/DSH Desktop/backend/dsh/node_modules/'
  const names = new Set()
  const collect = (rows) => rows.forEach((r) => { if (r.group === true) collect(r.config); else names.add(r.name) })
  collect(def.plugins)
  const missing = [...names].filter((n) => {
    if (n.startsWith('codebuddy') || n === 'cordis:group') return false
    // 裸说明符的包名：scoped 取两段（@scope/name），普通取一段（含子路径时剥掉）。
    const pkg = n.startsWith('@') ? n.split('/').slice(0, 2).join('/') : n.split('/')[0]
    return !existsSync(nm + pkg + '/package.json')
  })
  assert.deepEqual(missing, [], '所有官方插件名在已安装 dsh 中真实存在')
})
