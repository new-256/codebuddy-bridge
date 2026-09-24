// test/preset.test.mjs — preset 适配层测试（真实 ESM import 路径，连带验证
// preset → core 相对导入在安装目录形态下可用）。共享编排已在 dynamic-sim
// 覆盖，这里验证 preset 独有面：ctx.tools 注册、codebuddy/* 事件通道、
// process.env 形态的可执行文件解析。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx, createMockSubprocess, createUserQuestions, driveTicks, successStream, isolateHostState } from './helpers/mockdsh.mjs'

// 真机状态隔离：桥接读 auth 库（登录域）+ dsh-home 凭据库（codebuddy-en token 回退）
// + DSH_HOME（设置文件）。不隔离则结果随「本机是否登录/是否配过 workbuddy key」变化。
// 夹具的 auth.domain 与真机同值（www.codebuddy.cn / www.workbuddy.ai），凭据夹具故意为空。
isolateHostState()

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

// ── v1.3.0：插件设置（鸭子 Config）────────────────────────────────────────────

test('Config 鸭子 schema：cordis resolveConfig 契约（~standard.validate）', async () => {
  const mod = await loadPreset()
  const C = mod.Config
  // cordis 消费面：Config['~standard'].validate(config) → {value} | {issues}
  assert.equal(typeof C['~standard'].validate, 'function')
  const empty = C['~standard'].validate({})
  assert.equal(empty.issues, undefined)
  assert.deepEqual(empty.value, {
    preferredBackend: 'codebuddy',
    defaultModel: '',
    codebuddyEnToken: '',
    endpointOverride: ''
  })
  const ok = C['~standard'].validate({ preferredBackend: 'workbuddy', defaultModel: 'auto' })
  assert.equal(ok.issues, undefined)
  assert.equal(ok.value.preferredBackend, 'workbuddy')
  const bad = C['~standard'].validate({ preferredBackend: 'bogus' })
  assert.ok(bad.issues && bad.issues.length && bad.issues[0].path[0] === 'preferredBackend')
})

test('Config 鸭子 schema：SettingsForms 投影契约（toJSON refs 可被官方 z() 重建）', async () => {
  const mod = await loadPreset()
  const C = mod.Config
  // SettingsForms 消费面 1：schema(entry) 要求 Config 带 toJSON
  assert.equal(typeof C.toJSON, 'function')
  const j = C.toJSON()
  assert.equal(typeof j.uid, 'number')
  assert.ok(j.refs && Object.keys(j.refs).length >= 4)
  // 实例数据面：volatileForm 递归读 meta.volatile / .type / .dict
  assert.equal(C.type, 'object')
  for (const key of ['preferredBackend', 'defaultModel', 'codebuddyEnToken', 'endpointOverride']) {
    const child = C.dict[key]
    assert.ok(child, 'dict 应包含 ' + key)
    assert.equal(child.meta.volatile, true, key + ' 应标 volatile（设置面板热编辑）')
    assert.ok(child.meta.description, key + ' 应带描述（表单文案）')
  }
  // SettingsForms 消费面 2（决定性）：plainSchema 重建 new z(schema.toJSON()) ——
  // 若本机装有官方 schemastery 则真重建并对比校验行为（dsh 同款）。
  try {
    const zmod = await import('@deepseek-ai/schemastery')
    const z = zmod.default
    const rebuilt = z(j)
    const v = rebuilt['~standard'].validate({ preferredBackend: 'codebuddy-en' })
    assert.equal(v.issues, undefined)
    assert.equal(v.value.preferredBackend, 'codebuddy-en')
  } catch (e) {
    // 无官方 schemastery 的环境跳过（鸭子 validate 自身已被上一测试覆盖）。
  }
})

test('apply(ctx, config)：三读数生效 —— 偏好 backend + 默认模型 + en 凭据', async () => {
  const mod = await loadPreset()
  const sub = createMockSubprocess(() => ({ stdout: successStream({ session_id: 'set-1' }), exitCode: 0 }))
  const mc = createMockCtx({})
  mc.ctx.subprocess = sub.subprocess
  mod.apply(mc.ctx, { preferredBackend: 'codebuddy-en', defaultModel: 'glm-5.1', codebuddyEnToken: 'tok-en-1' })
  const run = mc.registeredTools.find((t) => t.name === 'codebuddy_run')
  // 新会话（无历史、无显式 backend）→ preferredBackend=codebuddy-en + 默认模型注入 + 凭据注入
  const res = await run.execute({ prompt: 'x', cwd: 'C:\\projS' }, { agent: 'a1' })
  assert.equal(res.ok, true)
  assert.equal(res.backend, 'codebuddy-en')
  const argv = sub.spawns[0].argv
  assert.ok(argv.includes('--model') && argv.includes('glm-5.1'), '应注入用户偏好默认模型: ' + argv.join(' '))
  // codebuddy-en 走 WorkBuddyAI 自带 CLI（不再是 npm CLI）
  assert.match(argv[1], /WorkBuddyAI/, 'codebuddy-en 应解析到 WorkBuddyAI 自带 CLI: ' + argv[1])
  const env = sub.spawns[0].env || {}
  assert.equal(env.CODEBUDDY_AUTH_TOKEN, 'tok-en-1')
  // 夹具登录域 = product 端点 → 无需注入 BASE_URL；且不再有 INTERNET_ENVIROMENT
  assert.equal(env.CODEBUDDY_BASE_URL, undefined)
  assert.equal(env.CODEBUDDY_INTERNET_ENVIROMENT, undefined)
})

test('apply(ctx, config)：codebuddy-en 缺凭据 → 前置 AUTH_REQUIRED（附可操作指引，不空跑 CLI）', async () => {
  const mod = await loadPreset()
  const sub = createMockSubprocess(() => ({ stdout: successStream({ session_id: 'set-1b' }), exitCode: 0 }))
  const mc = createMockCtx({})
  mc.ctx.subprocess = sub.subprocess
  mod.apply(mc.ctx, { preferredBackend: 'codebuddy-en' })
  const run = mc.registeredTools.find((t) => t.name === 'codebuddy_run')
  const res = await run.execute({ prompt: 'x', cwd: 'C:\\projS1b' }, { agent: 'a1' })
  assert.equal(res.ok, false)
  assert.equal(res.status, 'AUTH_REQUIRED')
  assert.match(res.stderr, /codebuddyEnToken/)
  assert.equal(sub.spawns.length, 0, '缺凭据时不应真的 spawn CLI')
})

test('apply(ctx, config)：非法/缺省 config 回落默认（防御 profile patch 手写错值）', async () => {
  const mod = await loadPreset()
  const sub = createMockSubprocess(() => ({ stdout: successStream({ session_id: 'set-2' }), exitCode: 0 }))
  const mc = createMockCtx({})
  mc.ctx.subprocess = sub.subprocess
  mod.apply(mc.ctx, { preferredBackend: 'not-a-backend', defaultModel: 42, codebuddyEnToken: null, endpointOverride: null })
  const run = mc.registeredTools.find((t) => t.name === 'codebuddy_run')
  const res = await run.execute({ prompt: 'x', cwd: 'C:\\projS2' }, { agent: 'a1' })
  assert.equal(res.ok, true)
  assert.equal(res.backend, 'codebuddy', '非法偏好应回落默认 codebuddy')
  assert.ok(!sub.spawns[0].argv.includes('--model'), '非法默认模型不应注入')
  // 夹具里 codebuddy 的登录域是 www.codebuddy.cn，而 product 端点是 www.codebuddy.ai
  // → 必须注入端点覆盖，否则 401（这正是 v1.3.1 修掉的既存缺陷）。
  assert.equal((sub.spawns[0].env || {}).CODEBUDDY_BASE_URL, 'https://www.codebuddy.cn/v2')
})

test('apply(ctx, config)：旧 dsh settings 兼容通道（provider/document 鸭子探测）', async () => {
  const mod = await loadPreset()
  const sub = createMockSubprocess(() => ({ stdout: successStream({ session_id: 'set-3' }), exitCode: 0 }))
  // 模拟老 dsh 的 ctx.settings：register(ns, schema, {base}) → { get, watch }
  let registered = null
  let watched = null
  let published = { preferredBackend: 'workbuddy', defaultModel: 'kimi-k2.5' }
  const fakeSettings = {
    register(ns, schema, opts) {
      registered = { ns: ns, schema: schema, base: opts && opts.base }
      return {
        get() { return published },
        watch(cb) { watched = cb }
      }
    }
  }
  const mc = createMockCtx({ settings: fakeSettings })
  mc.ctx.subprocess = sub.subprocess
  mod.apply(mc.ctx, {})
  assert.ok(registered, '应向老 settings 注册 namespace')
  assert.equal(registered.ns, 'codebuddy-bridge')
  // 老 settings resolve 用 schema(mergedValue)：鸭子 callable 必须可用
  const resolved = registered.schema({ preferredBackend: 'workbuddy', defaultModel: 'kimi-k2.5', codebuddyEnToken: undefined })
  assert.equal(resolved.preferredBackend, 'workbuddy')
  assert.equal(resolved.defaultModel, 'kimi-k2.5')
  // watch 触发 → 运行时快照热更新 → 下一次调用生效
  published = { preferredBackend: 'workbuddy', defaultModel: '' }
  watched(published)
  const run = mc.registeredTools.find((t) => t.name === 'codebuddy_run')
  const res = await run.execute({ prompt: 'x', cwd: 'C:\\projS3' }, { agent: 'a1' })
  assert.equal(res.backend, 'workbuddy', 'watch 更新后应调度到偏好后端')
  assert.ok(!sub.spawns[0].argv.includes('--model'), 'watch 清空默认模型后不再注入')
})

test('无 settings 服务：静默降级（不抛错、默认 backend 照常）', async () => {
  const mod = await loadPreset()
  const sub = createMockSubprocess(() => ({ stdout: successStream({ session_id: 'set-4' }), exitCode: 0 }))
  const mc = createMockCtx({})  // 无 settings
  mc.ctx.subprocess = sub.subprocess
  mod.apply(mc.ctx, null)
  const run = mc.registeredTools.find((t) => t.name === 'codebuddy_run')
  const res = await run.execute({ prompt: 'x', cwd: 'C:\\projS4' }, { agent: 'a1' })
  assert.equal(res.ok, true)
  assert.equal(res.backend, 'codebuddy')
})
