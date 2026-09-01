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
