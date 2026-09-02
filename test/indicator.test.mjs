// test/indicator.test.mjs — 家级状态灯 host 半（home-plugin/codebuddy-indicator）。
//
// v1.1.1 修复回归位：presetActive 原为粘滞标志——任何会话加载过一次
// codebuddy-first preset 后永不熄灭，导致所有会话（含非 codebuddy-first 模式）
// 常驻「CB 就绪」灯。现为心跳租约（30s 心跳 / TTL 75s），用注入时钟确定性验证。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createIndicatorState, apply } from '../home-plugin/codebuddy-indicator/lib/index.mjs'

function makeState() {
  let t = 0
  const st = createIndicatorState({ now: () => t, ttlMs: 75000 })
  return { st, tick: (ms) => { t += ms } }
}

test('indicator: 初始态 —— 无事件时 presetActive=false（非 preset 模式不渲染灯）', () => {
  const { st } = makeState()
  assert.deepEqual(st.snapshot(), { state: 'idle', running: 0, projects: [], presetActive: false, lastModeAt: 0 })
})

test('indicator: presetActive 心跳租约（v1.1.1 修复位）—— 无后续心跳则到期熄灭', () => {
  const { st, tick } = makeState()
  st.onMode({ active: true })
  assert.equal(st.snapshot().presetActive, true)
  tick(74999)
  assert.equal(st.snapshot().presetActive, true, 'TTL 内保持')
  tick(2)
  assert.equal(st.snapshot().presetActive, false, '超过 TTL（75s）自动熄灭——粘滞标志修复点')
  // 熄灭后不再复燃
  tick(600000)
  assert.equal(st.snapshot().presetActive, false)
})

test('indicator: 30s 心跳持续续期 —— codebuddy-first 会话开着时灯常亮', () => {
  const { st, tick } = makeState()
  st.onMode({ active: true })          // until = 75000
  tick(30000); st.onMode({ active: true })  // until = 105000
  tick(30000); st.onMode({ active: true })  // until = 135000
  tick(30000)                          // t = 90000
  assert.equal(st.snapshot().presetActive, true)
  tick(45001)                          // t = 135001，最后一拍之后无心跳
  assert.equal(st.snapshot().presetActive, false, '会话关闭（心跳停止）后 ≤75s 熄灭')
})

test('indicator: active:false 立即熄灭', () => {
  const { st } = makeState()
  st.onMode({ active: true })
  st.onMode({ active: false })
  assert.equal(st.snapshot().presetActive, false)
})

test('indicator: 非 preset 模式 ok 状态仅保持 8s；preset 模式保持 10 分钟', () => {
  let t = 0
  const now = () => t
  // 非 preset 模式：ok 项目 8s 后下线（灯随即消失）
  const st = createIndicatorState({ now, ttlMs: 75000 })
  st.mergeSnapshot({ projects: [{ cwd: '/p/a', state: 'ok', updatedAt: 1 }] })
  t = 7999
  assert.equal(st.snapshot().projects.length, 1)
  t = 8002
  assert.equal(st.snapshot().projects.length, 0, '非 preset 模式 ok 保持 8s 后下线')

  // preset 模式：ok 项目保持 10 分钟（租约需覆盖观察窗口——生产中心跳每 30s
  // 续期，此处用长租约单独验证 OK_HOLD 分支）
  const st2 = createIndicatorState({ now, ttlMs: 11 * 60 * 1000 })
  st2.onMode({ active: true })
  st2.mergeSnapshot({ projects: [{ cwd: '/p/b', state: 'ok', updatedAt: t }] })
  t += 9 * 60 * 1000
  let snap = st2.snapshot()
  assert.equal(snap.projects.length, 1, 'preset 模式 ok 保持 10 分钟（9 分钟处仍在）')
  assert.equal(snap.presetActive, true)
  t += 60 * 1000 + 2
  snap = st2.snapshot()
  assert.equal(snap.projects.length, 0, '10 分钟后下线')
})

test('indicator: running 与 fallbackActive 不受时间窗口影响', () => {
  const { st, tick } = makeState()
  st.mergeSnapshot({ projects: [
    { cwd: '/p/run', state: 'running', running: 2, updatedAt: 0 },
    { cwd: '/p/fb', state: 'failed', fallbackActive: true, updatedAt: 0 }
  ] })
  tick(3600 * 1000)
  const snap = st.snapshot()
  assert.equal(snap.state, 'running')
  assert.equal(snap.running, 2)
  assert.equal(snap.projects.length, 2)
  assert.ok(snap.projects.some((p) => p.fallbackActive))
})

test('indicator: 项目容量淘汰（MAX_PROJECTS=24，MRU 保留）', () => {
  const { st } = makeState()
  for (let i = 0; i < 30; i++) {
    st.mergeSnapshot({ projects: [{ cwd: '/p/' + i, state: 'idle', updatedAt: i + 1 }] })
  }
  const snap = st.snapshot() // idle 只在 STALE_MS(10min) 内保留 → 全部仍在窗口内
  // 30 > 24：最旧的 idle 项被淘汰
  assert.equal(snap.projects.length, 24)
  assert.ok(!snap.projects.some((p) => p.cwd === '/p/0'), '最旧淘汰')
  assert.ok(snap.projects.some((p) => p.cwd === '/p/29'), '最新保留')
})

test('indicator: 快照可无损 JSON 序列化（通道契约）', () => {
  const { st } = makeState()
  st.onMode({ active: true })
  st.mergeSnapshot({ projects: [{ cwd: '/p/a', state: 'running', running: 1, current: { stepIndex: 1, tool: 'Write', args: null }, trail: [{ state: 'ACTIVE', tool: 'Write', stepIndex: 1 }] }] })
  const j = JSON.parse(JSON.stringify(st.snapshot()))
  assert.equal(j.state, 'running')
  assert.equal(j.projects[0].current.args, null)
})

test('indicator: apply() 装配 —— mode/status 事件入状态机，webServer 路由吐快照 JSON', async () => {
  const handlers = Object.create(null)
  const provided = Object.create(null)
  let injectCb = null
  let route = null
  const ctx = {
    on: (name, cb) => { handlers[name] = cb },
    provide: (name, svc) => { provided[name] = svc },
    inject: (deps, cb) => { injectCb = cb }
  }
  apply(ctx)
  assert.ok(handlers['codebuddy/mode'], 'mode 事件已挂')
  assert.ok(handlers['codebuddy/status'], 'status 事件已挂')
  assert.ok(provided.codebuddyCollector, 'collector 服务已提供')

  // 模拟 webServer 注入
  const registered = []
  const ws = { register: (r) => { registered.push(r); return () => {} } }
  const webCtx = { get: () => ws, effect: (fn) => { fn(); return () => {} } }
  injectCb(webCtx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, '/codebuddy-indicator/status')

  handlers['codebuddy/mode']({ active: true })
  handlers['codebuddy/status']({ snapshot: { projects: [{ cwd: '/p/x', state: 'ok' }] } })
  let body = null
  const res = { writeHead: () => {}, end: (b) => { body = b } }
  registered[0].handler({}, res)
  const parsed = JSON.parse(body)
  assert.equal(parsed.presetActive, true)
  assert.equal(parsed.state, 'ok')
  assert.equal(parsed.projects[0].cwd, '/p/x')
  // collector 直推（动态形态通道）
  provided.codebuddyCollector.mergeSnapshot({ projects: [{ cwd: '/p/y', state: 'running', running: 1 }] })
  registered[0].handler({}, res)
  const parsed2 = JSON.parse(body)
  assert.equal(parsed2.state, 'running')
  assert.equal(parsed2.running, 1)
})
