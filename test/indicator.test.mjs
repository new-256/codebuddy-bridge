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
  assert.deepEqual(st.snapshot(), { state: 'idle', running: 0, projects: [], presetActive: false, presetSessions: [], lastModeAt: 0 })
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

test('indicator: 实时枚举为权威来源（v1.1.3）—— 无需上报即产出会话名单', () => {
  let live = ['live-1', 'live-2']
  let t = 0
  const st = createIndicatorState({ now: () => t, ttlMs: 75000, listPresetSessions: () => live })
  assert.deepEqual(st.snapshot().presetSessions.slice().sort(), ['live-1', 'live-2'], '未收到任何 mode 事件也能判定')
  assert.equal(st.snapshot().presetActive, true)
  // 会话关闭 → 枚举立即不含它（无需等租约）
  live = ['live-2']
  assert.deepEqual(st.snapshot().presetSessions, ['live-2'])
  live = []
  assert.deepEqual(st.snapshot().presetSessions, [])
  assert.equal(st.snapshot().presetActive, false, '两源皆空 → 灯灭')
})

test('indicator: 双源取并集且去重 —— 枚举 ∪ 上报租约', () => {
  let t = 0
  const st = createIndicatorState({ now: () => t, ttlMs: 75000, listPresetSessions: () => ['a', 'b'] })
  st.onMode({ active: true, sessionId: 'b' })   // 与枚举重合
  st.onMode({ active: true, sessionId: 'c' })   // 仅上报有
  assert.deepEqual(st.snapshot().presetSessions.slice().sort(), ['a', 'b', 'c'], '并集')
  assert.equal(st.snapshot().presetSessions.filter((x) => x === 'b').length, 1, '去重')
})

test('indicator: 枚举器抛错时安全降级到上报租约', () => {
  let t = 0
  const st = createIndicatorState({ now: () => t, ttlMs: 75000, listPresetSessions: () => { throw new Error('DSH 内部 API 变动') } })
  st.onMode({ active: true, sessionId: 's1' })
  assert.deepEqual(st.snapshot().presetSessions, ['s1'], '枚举失败不影响兜底通道')
  assert.equal(st.snapshot().presetActive, true)
})

test('indicator: 按会话租约（v1.1.3）—— presetSessions 只含仍在心跳的会话', () => {
  const { st, tick } = makeState()
  st.onMode({ active: true, sessionId: 's1' })
  assert.deepEqual(st.snapshot().presetSessions, ['s1'])
  assert.equal(st.snapshot().presetActive, true, '有会话在线 → 全局标志同时为真（旧客户端兼容）')
  tick(30000); st.onMode({ active: true, sessionId: 's2' })
  assert.deepEqual(st.snapshot().presetSessions.slice().sort(), ['s1', 's2'])
  tick(45001)  // s1 未续期（t=75001 > s1 租约 75000），s2 仍在（到 105000）
  assert.deepEqual(st.snapshot().presetSessions, ['s2'], 's1 租约到期离场，s2 保留')
})

test('indicator: 会话关闭主动下线 —— active:false 带 sessionId 只熄灭该会话', () => {
  const { st } = makeState()
  st.onMode({ active: true, sessionId: 's1' })
  st.onMode({ active: true, sessionId: 's2' })
  st.onMode({ active: false, sessionId: 's1' })
  assert.deepEqual(st.snapshot().presetSessions, ['s2'], 's1 立即离场，不必等 75s 租约')
  assert.equal(st.snapshot().presetActive, true, '仍有 s2 在线')
  st.onMode({ active: false, sessionId: 's2' })
  assert.deepEqual(st.snapshot().presetSessions, [])
  assert.equal(st.snapshot().presetActive, false, '最后一个会话离场 → 全局标志也熄灭（旧客户端立即熄灯）')
})

test('indicator: 旧版 preset（不带 sessionId）仍走全局租约语义', () => {
  const { st, tick } = makeState()
  st.onMode({ active: true })
  assert.deepEqual(st.snapshot().presetSessions, [], '没有会话名单 → 客户端回退全局判定')
  assert.equal(st.snapshot().presetActive, true)
  tick(75001)
  assert.equal(st.snapshot().presetActive, false)
})

test('indicator: 会话名单容量上限（MAX_SESSIONS=64，丢最早到期）', () => {
  const { st, tick } = makeState()
  for (let i = 0; i < 70; i++) { tick(1); st.onMode({ active: true, sessionId: 's' + i }) }
  const list = st.snapshot().presetSessions
  assert.equal(list.length, 64, '超出上限被裁剪')
  assert.ok(!list.includes('s0'), '最早到期的被丢弃')
  assert.ok(list.includes('s69'), '最新的保留')
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
  // 实时枚举依赖的两个服务：一个 codebuddy-first 会话 + 一个普通会话
  const cbAgent = { id: 'live-cb', ctx: { tag: 'cb' } }
  const otherAgent = { id: 'live-other', ctx: { tag: 'other' } }
  const services = {
    agents: { list: () => [cbAgent, otherAgent] },
    agentPresets: { composedPreset: (c) => (c && c.tag === 'cb' ? 'codebuddy-first' : undefined) }
  }
  const ctx = {
    on: (name, cb) => { handlers[name] = cb },
    provide: (name, svc) => { provided[name] = svc },
    inject: (deps, cb) => { injectCb = cb },
    get: (name) => services[name]
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
  // 按会话租约端到端：带 sessionId 的宣告要出现在路由返回的 presetSessions 里
  handlers['codebuddy/mode']({ active: true, sessionId: 'sess-abc' })
  registered[0].handler({}, res)
  const list = JSON.parse(body).presetSessions.slice().sort()
  assert.deepEqual(list, ['live-cb', 'sess-abc'], '实时枚举（live-cb，非上报）∪ 上报（sess-abc）经路由送达；普通会话 live-other 不在名单')
  // collector 直推（动态形态通道）
  provided.codebuddyCollector.mergeSnapshot({ projects: [{ cwd: '/p/y', state: 'running', running: 1 }] })
  registered[0].handler({}, res)
  const parsed2 = JSON.parse(body)
  assert.equal(parsed2.state, 'running')
  assert.equal(parsed2.running, 1)
})
