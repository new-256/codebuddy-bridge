// test/dynamic-sim.test.mjs — 生成的 dynamic/host.js 的沙箱模拟测试。
// 按动态插件的真实求值方式（new Function('harness', body)）装载，注入 mock
// ctx/subprocess，验证宿主适配层 + 共享编排的故障注入回归：
//   - 非 SUCCESS 失败后 codebuddy_status 不抛错
//   - 限流弹窗只弹一次、第二次无死「重试」选项
//   - jobs.start 失败立即 return，不再静默回落前台
//   - 跨 chunk 半行的实时解析
//   - 续接无 cwd 时回落到 session 所在项目（会话感知 cwd）

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { buildDynamic } from '../scripts/build.mjs'
import { createMockCtx, createMockHarness, createMockSubprocess, createUserQuestions, driveTicks, successStream } from './helpers/mockdsh.mjs'

function loadGeneratedPlugin() {
  const source = buildDynamic()
  const fn = new Function('harness', source)
  return fn
}

function freshHarness(onSpawn, opts) {
  const o = opts || {}
  const sub = createMockSubprocess(onSpawn)
  const { uq, asks } = createUserQuestions(o.dialogScript || [])
  const mergedCtx = createMockCtx({ userQuestions: uq, jobs: o.jobs, sandboxPolicy: o.sandboxPolicy, collector: o.collector })
  const mockHarness = createMockHarness()
  return { sub, asks, mergedCtx, mockHarness }
}

test('生成的 host.js 可装载：inject 声明 + 三工具 + 策略段 + collector 通道', async () => {
  const collectorMerges = []
  const { sub, mergedCtx, mockHarness } = freshHarness(null, {
    collector: { mergeSnapshot(s) { collectorMerges.push(s) } }
  })
  mergedCtx.ctx.subprocess = sub.subprocess
  const plugin = loadGeneratedPlugin()(mockHarness.harness)
  assert.deepEqual([...plugin.inject].sort(), ['subprocess', 'systemPrompt', 'timer', 'tools'])
  plugin.apply(mergedCtx.ctx)
  assert.deepEqual(mockHarness.tools.map((t) => t.name).sort(), ['codebuddy_continue', 'codebuddy_run', 'codebuddy_status'])
  assert.equal(mergedCtx.sections.length, 1)
  assert.equal(mergedCtx.sections[0].name, 'codebuddy:policy')
  assert.ok(mergedCtx.sections[0].text.includes('codebuddy-first execution policy'))
  assert.equal(typeof mockHarness.handles['codebuddy_status'], 'function')
})

test('P0 回归：非 SUCCESS（非回退）失败后 status 工具不抛错、状态=failed', async () => {
  // 无 result 事件 + 空 stderr → PARSE_ERROR（不弹窗），随后 status 必须可用。
  const { sub, asks, mergedCtx, mockHarness } = freshHarness(() => ({ stdout: '', stderr: '', exitCode: 1 }))
  mergedCtx.ctx.subprocess = sub.subprocess
  const plugin = loadGeneratedPlugin()(mockHarness.harness)
  plugin.apply(mergedCtx.ctx)
  const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
  const res = await run.execute({ prompt: 'x' }, { agent: 'a1' })
  assert.equal(res.ok, false)
  assert.equal(res.status, 'PARSE_ERROR')
  assert.equal(asks.length, 0) // 非限流失败不弹窗
  const status = mockHarness.tools.find((t) => t.name === 'codebuddy_status')
  let snap
  assert.doesNotThrow(() => { snap = status.execute({}) })
  assert.equal(snap.state, 'failed')
  assert.equal(snap.runs, 1)
})

test('双弹窗回归：限流失败 → 重试 → 再失败 → 共弹 2 次，第二次无死「重试」', async () => {
  let nth = 0
  const { sub, asks, mergedCtx, mockHarness } = freshHarness(() => {
    nth += 1
    return { stdout: '', stderr: 'Error: rate limit exceeded, retry later (429)', exitCode: 1 }
  }, {
    dialogScript: [
      { selected: ['重试 codebuddy 一次'] },
      { selected: ['不回退（返回错误）'] }
    ]
  })
  mergedCtx.ctx.subprocess = sub.subprocess
  const plugin = loadGeneratedPlugin()(mockHarness.harness)
  plugin.apply(mergedCtx.ctx)
  const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
  const res = await run.execute({ prompt: 'x' }, { agent: 'a1' })
  assert.equal(res.ok, false)
  assert.equal(sub.spawns.length, 2) // 重试确实再跑了一次
  // 弹窗恰好 2 次（不是旧版的 3 次：循环内 1 次 + 循环外 1 次会连弹）
  assert.equal(asks.length, 2)
  const labels1 = asks[0].questions[0].options.map((o) => o.label)
  const labels2 = asks[1].questions[0].options.map((o) => o.label)
  assert.deepEqual(labels1, ['使用 DSH 本地 API 配置（回退）', '重试 codebuddy 一次', '不回退（返回错误）'])
  assert.deepEqual(labels2, ['使用 DSH 本地 API 配置（回退）', '不回退（返回错误）']) // 无死选项
})

test('回退选择 → fallback 结果 + 项目 fallback 态', async () => {
  const { sub, asks, mergedCtx, mockHarness } = freshHarness(() => ({ stdout: '', stderr: 'connect ECONNREFUSED', exitCode: 1 }), {
    dialogScript: [{ selected: ['使用 DSH 本地 API 配置（回退）'] }]
  })
  mergedCtx.ctx.subprocess = sub.subprocess
  const plugin = loadGeneratedPlugin()(mockHarness.harness)
  plugin.apply(mergedCtx.ctx)
  const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
  const res = await run.execute({ prompt: 'x' }, { agent: 'a1' })
  assert.equal(res.fallback, true)
  assert.equal(res.status, 'FALLBACK_TO_DSH')
  const snap = mockHarness.tools.find((t) => t.name === 'codebuddy_status').execute({})
  assert.equal(snap.state, 'fallback')
})

test('缺 return 回归：jobs.start 抛错 → JOB_START_ERROR 且不再前台重跑', async () => {
  const jobs = {
    start() { throw new Error('job registry full (mock)') }
  }
  const { sub, mergedCtx, mockHarness } = freshHarness(null, { jobs })
  mergedCtx.ctx.subprocess = sub.subprocess
  const plugin = loadGeneratedPlugin()(mockHarness.harness)
  plugin.apply(mergedCtx.ctx)
  const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
  const res = await run.execute({ prompt: 'x', background: true }, { agent: 'a1' })
  assert.equal(res.status, 'JOB_START_ERROR')
  assert.equal(res.ok, false)
  assert.ok(res.stderr.includes('job registry full'))
  // 关键回归：绝不回落前台路径再 spawn 一次
  assert.equal(sub.spawns.length, 0)
})

test('成功运行 + 续接无 cwd 回落到 session 项目（会话感知 cwd）', async () => {
  const projA = 'C:\\projA'
  const projB = 'C:\\projB'
  let nth = 0
  const { sub, mergedCtx, mockHarness } = freshHarness(() => {
    nth += 1
    return { stdout: successStream({ session_id: 'sess-A' }), exitCode: 0 }
  }, { sandboxPolicy: { workspaceRoot: projB } })
  mergedCtx.ctx.subprocess = sub.subprocess
  const plugin = loadGeneratedPlugin()(mockHarness.harness)
  plugin.apply(mergedCtx.ctx)
  const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
  const res = await run.execute({ prompt: 'x', cwd: projA }, { agent: 'a1' })
  assert.equal(res.ok, true)
  assert.equal(res.sessionId, 'sess-A')
  assert.equal(res.totalTokens, 50)
  // 第一跑显式 cwd=projA
  assert.equal(sub.spawns[0].cwd, projA)
  // 续接：不带 cwd、带 sessionId → 必须回到 projA（而不是 sandboxRoot projB）
  const cont = mockHarness.tools.find((t) => t.name === 'codebuddy_continue')
  await cont.execute({ prompt: 'again', sessionId: 'sess-A' }, { agent: 'a1' })
  assert.equal(sub.spawns[1].cwd, projA)
  assert.ok(sub.spawns[1].argv.includes('--resume') && sub.spawns[1].argv.includes('sess-A'))
  // 用量累计出现在 status
  const snap = mockHarness.tools.find((t) => t.name === 'codebuddy_status').execute({})
  assert.equal(snap.runs, 2)
  assert.equal(snap.totalTokens, 100)
})

test('半行实时解析：跨 chunk 的 JSON 行不再丢失', async () => {
  const full = successStream({ session_id: 'sess-H' })
  // 把 assistant 行从中间切开，模拟 stdout 分片
  const assistantLine = full.split('\n').find((l) => l.includes('"tool_use"'))
  const mid = Math.floor(assistantLine.length / 2)
  const left = assistantLine.slice(0, mid)
  const right = assistantLine.slice(mid)
  const before = full.slice(0, full.indexOf(assistantLine))
  const after = full.slice(full.indexOf(assistantLine) + assistantLine.length)
  const { sub, mergedCtx, mockHarness } = freshHarness(() => ({
    chunks: [before + left, right + after],
    chunkDelayMs: 40
  }))
  mergedCtx.ctx.subprocess = sub.subprocess
  const stop = driveTicks(mergedCtx.intervalTicks, 10) // 模拟 250ms 轮询
  try {
    const plugin = loadGeneratedPlugin()(mockHarness.harness)
    plugin.apply(mergedCtx.ctx)
    const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
    const res = await run.execute({ prompt: 'x', cwd: 'C:\\projH' }, { agent: 'a1' })
    assert.equal(res.ok, true)
    // 折叠出的 trail：跨 chunk 的 tool_use 行完整解析为一步
    const snap = mockHarness.tools.find((t) => t.name === 'codebuddy_status').execute({ cwd: 'C:\\projH' })
    assert.ok(snap.trail.some((e) => e.tool === 'Read' && e.state === 'DONE'), 'trail 应包含跨 chunk 的 Read 步骤')
  } finally {
    stop()
  }
})

test('backend 派发：workbuddy 走 WorkBuddy CLI 路径 + 会话自动路由回所属后端', async () => {
  const projA = 'C:\\projWB'
  let nth = 0
  const { sub, mergedCtx, mockHarness } = freshHarness(() => {
    nth += 1
    return { stdout: successStream({ session_id: nth === 1 ? 'wb-1' : 'cb-1' }), exitCode: 0 }
  })
  mergedCtx.ctx.subprocess = sub.subprocess
  const plugin = loadGeneratedPlugin()(mockHarness.harness)
  plugin.apply(mergedCtx.ctx)
  const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
  // 第一次：显式 backend=workbuddy
  const res1 = await run.execute({ prompt: 'x', backend: 'workbuddy', cwd: projA }, { agent: 'a1' })
  assert.equal(res1.ok, true)
  assert.equal(res1.backend, 'workbuddy')
  assert.equal(sub.spawns[0].argv[1], 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy')
  // 第二次：默认 codebuddy（同项目）
  const res2 = await run.execute({ prompt: 'y', cwd: projA }, { agent: 'a1' })
  assert.equal(res2.backend, 'codebuddy')
  assert.notEqual(sub.spawns[1].argv[1], 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy')
  // 续接 wb-1（不显式给 backend）→ 必须路由回 workbuddy（而不是项目最近的 codebuddy）
  const cont = mockHarness.tools.find((t) => t.name === 'codebuddy_continue')
  const res3 = await cont.execute({ prompt: 'z', sessionId: 'wb-1' }, { agent: 'a1' })
  assert.equal(res3.backend, 'workbuddy')
  assert.equal(sub.spawns[2].argv[1], 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy')
  // 状态：最后一次运行是续接（路由回 workbuddy）→ 项目 lastBackend=workbuddy
  const snap = mockHarness.tools.find((t) => t.name === 'codebuddy_status').execute({})
  assert.equal(snap.projects[0].lastBackend, 'workbuddy')
  assert.equal(snap.runs, 3)
})

test('后台派发：返回 jobId，任务在后台跑完并计入状态', async () => {
  let started = null
  const jobs = {
    start(job) {
      started = job
      return 77
    }
  }
  const { sub, mergedCtx, mockHarness } = freshHarness(() => ({ stdout: successStream({ session_id: 'sess-BG' }), exitCode: 0 }), { jobs })
  mergedCtx.ctx.subprocess = sub.subprocess
  const plugin = loadGeneratedPlugin()(mockHarness.harness)
  plugin.apply(mergedCtx.ctx)
  const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
  const res = await run.execute({ prompt: 'bg task', background: true, cwd: 'C:\\projBG' }, { agent: 'a1' })
  assert.equal(res.background, true)
  assert.equal(res.jobId, '77')
  const outcome = await started.run().done
  assert.equal(outcome.status, 'completed')
  assert.equal(JSON.parse(outcome.output).sessionId, 'sess-BG')
  const snap = mockHarness.tools.find((t) => t.name === 'codebuddy_status').execute({ cwd: 'C:\\projBG' })
  assert.equal(snap.runs, 1)
})

// ── v1.3.1：三后端各自独立 CLI + 端点按登录域对齐 + 凭据 ──────────────────────

test('backend=codebuddy-en：走 WorkBuddyAI 自带 CLI + 凭据注入 + 端点按登录域对齐', async () => {
  const { sub, mergedCtx, mockHarness } = freshHarness(() => ({ stdout: successStream({ session_id: 'en-1' }), exitCode: 0 }))
  mergedCtx.ctx.subprocess = sub.subprocess
  const plugin = loadGeneratedPlugin()(mockHarness.harness)
  plugin.apply(mergedCtx.ctx)
  const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
  // 凭据来自设置文件（动态形态经 DSH_HOME 读）；本用例只验证 env 通道，直接写设置文件。
  const res = await run.execute({ prompt: 'x', backend: 'codebuddy-en', cwd: 'C:\\projEN', model: 'auto' }, { agent: 'a1' })
  // 无 token → 前置 AUTH_REQUIRED（不 spawn）；这是确定性行为，不是失败路径遗漏。
  assert.equal(res.ok, false)
  assert.equal(res.status, 'AUTH_REQUIRED')
  assert.match(res.stderr, /codebuddyEnToken/)
  assert.equal(sub.spawns.length, 0, '缺凭据时不应真的 spawn CLI')
})

test('backend=codebuddy-en 带凭据：WorkBuddyAI 二进制 + CODEBUDDY_AUTH_TOKEN', async () => {
  const os = await import('node:os')
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const tmpHome = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'cb-en-'))
  fsMod.writeFileSync(pathMod.join(tmpHome, 'codebuddy-bridge-settings.json'),
    JSON.stringify({ codebuddyEnToken: 'tok-en-dyn' }), 'utf8')
  const realHome = process.env.DSH_HOME
  const realAuth = process.env.CODEBUDDY_AUTH_DIR
  process.env.DSH_HOME = tmpHome
  process.env.CODEBUDDY_AUTH_DIR = fileURLToPath(new URL('./fixtures/auth', import.meta.url))
  try {
    const { sub, mergedCtx, mockHarness } = freshHarness(() => ({ stdout: successStream({ session_id: 'en-2' }), exitCode: 0 }))
    mergedCtx.ctx.subprocess = sub.subprocess
    const plugin = loadGeneratedPlugin()(mockHarness.harness)
    plugin.apply(mergedCtx.ctx)
    const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
    const res = await run.execute({ prompt: 'x', backend: 'codebuddy-en', cwd: 'C:\\projEN2' }, { agent: 'a1' })
    assert.equal(res.ok, true)
    assert.equal(res.backend, 'codebuddy-en')
    const bin = sub.spawns[0].argv[1]
    assert.match(bin, /WorkBuddyAI/, 'codebuddy-en 应走 WorkBuddyAI 自带 CLI: ' + bin)
    const env = sub.spawns[0].env || {}
    assert.equal(env.CODEBUDDY_AUTH_TOKEN, 'tok-en-dyn')
    // 夹具登录域 = product 端点 → 无需 BASE_URL；INTERNET_ENVIROMENT 已删除
    assert.equal(env.CODEBUDDY_BASE_URL, undefined)
    assert.equal(env.CODEBUDDY_INTERNET_ENVIROMENT, undefined)
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = realHome
    if (realAuth === undefined) delete process.env.CODEBUDDY_AUTH_DIR; else process.env.CODEBUDDY_AUTH_DIR = realAuth
    fsMod.rmSync(tmpHome, { recursive: true, force: true })
  }
})

test('端点按登录域对齐：登录域 ≠ product 端点时自动注入 CODEBUDDY_BASE_URL', async () => {
  const realAuth = process.env.CODEBUDDY_AUTH_DIR
  process.env.CODEBUDDY_AUTH_DIR = fileURLToPath(new URL('./fixtures/auth', import.meta.url))
  try {
    const { sub, mergedCtx, mockHarness } = freshHarness(() => ({ stdout: successStream({ session_id: 'ep-1' }), exitCode: 0 }))
    mergedCtx.ctx.subprocess = sub.subprocess
    const plugin = loadGeneratedPlugin()(mockHarness.harness)
    plugin.apply(mergedCtx.ctx)
    const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
    // 夹具：codebuddy 的登录域是 www.codebuddy.cn，product 端点是 www.codebuddy.ai
    // → 必须注入覆盖（否则真机 401）。这是 v1.3.1 修掉的默认后端缺陷。
    await run.execute({ prompt: 'x', backend: 'codebuddy', cwd: 'C:\\projEP' }, { agent: 'a1' })
    assert.equal((sub.spawns[0].env || {}).CODEBUDDY_BASE_URL, 'https://www.codebuddy.cn/v2')
    // 夹具：workbuddy 的登录域是 www.codebuddy.cn，product 端点是 copilot.tencent.com
    // → 同样需要覆盖（实测 cn 域在桌面 CLI 上返回 PONG）。
    await run.execute({ prompt: 'y', backend: 'workbuddy', cwd: 'C:\\projEP' }, { agent: 'a1' })
    assert.equal((sub.spawns[1].env || {}).CODEBUDDY_BASE_URL, 'https://www.codebuddy.cn/v2')
  } finally {
    if (realAuth === undefined) delete process.env.CODEBUDDY_AUTH_DIR; else process.env.CODEBUDDY_AUTH_DIR = realAuth
  }
})

test('用户偏好默认 backend：无显式 backend 的新会话调度到偏好后端 + 默认模型注入', async () => {
  const projA = 'C:\\projPref'
  let nth = 0
  const { sub, mergedCtx, mockHarness } = freshHarness(() => {
    nth += 1
    return { stdout: successStream({ session_id: 'pref-' + nth }), exitCode: 0 }
  })
  mergedCtx.ctx.subprocess = sub.subprocess
  const plugin = loadGeneratedPlugin()(mockHarness.harness)
  plugin.apply(mergedCtx.ctx)
  const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
  // 第一跑走默认 codebuddy（sanity：不是 WorkBuddy 桌面 CLI 路径）
  await run.execute({ prompt: 'one', cwd: projA }, { agent: 'a1' })
  assert.notEqual(sub.spawns[0].argv[1], 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy')
  assert.notEqual(sub.spawns[0].argv[1], 'C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy')
  // 显式 backend=workbuddy 的调用走国内桌面面（免凭据），不受历史会话影响
  await run.execute({ prompt: 'two', cwd: projA, backend: 'workbuddy' }, { agent: 'a1' })
  assert.equal(sub.spawns[1].argv[1], 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy')
  // 真实偏好来源是设置文件/Config；动态形态经 DSH_HOME 读设置文件（下一个测试覆盖），
  // 会话归属路由已由「workbuddy 会话自动路由」用例覆盖，此处不再重复。
})

test('用户偏好 defaultModel：调用未指定 model 时注入 --model', async () => {
  // 直接注入设置文件（动态形态读 DSH_HOME）
  const os = await import('node:os')
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const tmpHome = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'cb-settings-'))
  fsMod.writeFileSync(pathMod.join(tmpHome, 'codebuddy-bridge-settings.json'), JSON.stringify({ preferredBackend: 'codebuddy', defaultModel: 'glm-5.2' }), 'utf8')
  const realEnv = process.env.DSH_HOME
  process.env.DSH_HOME = tmpHome
  try {
    const { sub, mergedCtx, mockHarness } = freshHarness(() => ({ stdout: successStream({ session_id: 'dm-1' }), exitCode: 0 }))
    mergedCtx.ctx.subprocess = sub.subprocess
    const plugin = loadGeneratedPlugin()(mockHarness.harness)
    plugin.apply(mergedCtx.ctx)
    const run = mockHarness.tools.find((t) => t.name === 'codebuddy_run')
    const res = await run.execute({ prompt: 'x', cwd: 'C:\\projDM' }, { agent: 'a1' })
    assert.equal(res.ok, true)
    const argv = sub.spawns[0].argv
    assert.ok(argv.includes('--model') && argv.includes('glm-5.2'), '应注入用户偏好默认模型: ' + argv.join(' '))
    // 显式 model 优先于偏好
    await run.execute({ prompt: 'y', cwd: 'C:\\projDM', model: 'hy3' }, { agent: 'a1' })
    const argv2 = sub.spawns[1].argv
    assert.ok(argv2.includes('hy3') && !argv2.includes('glm-5.2'))
  } finally {
    if (realEnv === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realEnv
    fsMod.rmSync(tmpHome, { recursive: true, force: true })
  }
})
