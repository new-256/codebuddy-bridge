// test/preset.test.mjs — preset 适配层测试（真实 ESM import 路径，连带验证
// preset → core 相对导入在安装目录形态下可用）。共享编排已在 dynamic-sim
// 覆盖，这里验证 preset 独有面：ctx.tools 注册、codebuddy/* 事件通道、
// process.env 形态的可执行文件解析。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx, createMockSubprocess, createUserQuestions, driveTicks, successStream } from './helpers/mockdsh.mjs'

async function loadPreset() {
  // import() 直接接受 file:// URL（Windows 下 pathname 拼接会产生双盘符）
  return import(new URL('../preset/codebuddy-first/codebuddy-first-bridge.mjs', import.meta.url).href)
}

test('preset 模块导出与注册面', async () => {
  const mod = await loadPreset()
  assert.equal(mod.name, 'codebuddy-first-bridge')
  assert.deepEqual([...mod.inject].sort(), ['subprocess', 'systemPrompt', 'timer', 'tools'])
  const sub = createMockSubprocess(() => ({ stdout: successStream(), exitCode: 0 }))
  const mc = createMockCtx({})
  mc.ctx.subprocess = sub.subprocess
  mod.apply(mc.ctx)
  assert.deepEqual(mc.registeredTools.map((t) => t.name).sort(), ['codebuddy_continue', 'codebuddy_run', 'codebuddy_status'])
  assert.equal(mc.sections.length, 1)
  // 挂载即宣告 codebuddy 优先模式（家级灯 presetActive）
  const mode = mc.events.find((e) => e.ev === 'codebuddy/mode')
  assert.ok(mode && mode.payload.active === true)
})

test('preset：成功运行推 codebuddy/status 事件（灯数据通道）+ 故障后 status 可用', async () => {
  const mod = await loadPreset()
  let nth = 0
  const sub = createMockSubprocess(() => {
    nth += 1
    return nth === 1
      ? { stdout: successStream({ session_id: 'sess-P' }), exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 1 }
  })
  const mc = createMockCtx({})
  mc.ctx.subprocess = sub.subprocess
  mod.apply(mc.ctx)
  const run = mc.registeredTools.find((t) => t.name === 'codebuddy_run')
  const status = mc.registeredTools.find((t) => t.name === 'codebuddy_status')

  const res = await run.execute({ prompt: 'x', cwd: 'C:\\projP' }, { agent: 'a1' })
  assert.equal(res.ok, true)
  // 事件通道：running → ok 的快照都发过了
  const snaps = mc.events.filter((e) => e.ev === 'codebuddy/status').map((e) => e.payload.snapshot)
  assert.ok(snaps.length >= 2)
  assert.ok(snaps.some((s) => s.state === 'running'))
  assert.ok(snaps.some((s) => s.state === 'ok'))
  // 事件负载必须无损 JSON（通道级验证）
  assert.doesNotThrow(() => snaps.forEach((s) => JSON.stringify(s)))

  // 故障注入：第二次运行 PARSE_ERROR → status 工具不抛错（P0 回归）
  const bad = await run.execute({ prompt: 'y', cwd: 'C:\\projP' }, { agent: 'a1' })
  assert.equal(bad.status, 'PARSE_ERROR')
  let snap
  assert.doesNotThrow(() => { snap = status.execute({}) })
  assert.equal(snap.state, 'failed')
  assert.equal(snap.projects[0].runs, 2)
})

test('preset：process.env 形态解析 —— CODEBUDDY_BIN 命中时走 node+bin', async () => {
  const mod = await loadPreset()
  const savedBin = process.env.CODEBUDDY_BIN
  try {
    process.env.CODEBUDDY_BIN = 'C:\\tools\\cb-bin'
    const sub = createMockSubprocess(() => ({ stdout: successStream(), exitCode: 0 }))
    const mc = createMockCtx({})
    mc.ctx.subprocess = sub.subprocess
    mod.apply(mc.ctx)
    const run = mc.registeredTools.find((t) => t.name === 'codebuddy_run')
    await run.execute({ prompt: 'x', cwd: 'C:\\projQ' }, { agent: 'a1' })
    // resolveExecutable 全部抛错（mock 默认）→ 回退 [node, CODEBUDDY_BIN]
    assert.equal(sub.spawns[0].argv[0], process.execPath || 'node')
    assert.ok(sub.spawns[0].argv.includes('C:\\tools\\cb-bin'))
  } finally {
    if (savedBin === undefined) delete process.env.CODEBUDDY_BIN
    else process.env.CODEBUDDY_BIN = savedBin
  }
})
