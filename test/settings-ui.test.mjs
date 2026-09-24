// test/settings-ui.test.mjs — v1.3.2 可视化配置界面的全链路测试。
// 覆盖三层：
//   core    设置文件原语（读/写/原子性/清洗/路径注入）
//   host    indicator 的 GET/POST /codebuddy-indicator/settings 路由（含 token
//           保持/清除语义与掩码不回传明文）
//   preset  面板保存的热生效（每次调用现读文件；文件优先于行 config）
//   client  settings.section 注册形状 + 组件烟测（假 react，不触网）
// 隔离：isolateHostState() 把 DSH_HOME 指到临时目录；本文件再用
// CODEBUDDY_SETTINGS_FILE 钉死设置文件路径，与其他测试文件的临时 DSH_HOME 互不干扰。

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolateHostState, createMockCtx, createMockSubprocess, successStream } from './helpers/mockdsh.mjs'

isolateHostState()

const TMP = mkdtempSync(join(tmpdir(), 'cb-settings-ui-'))
const SETTINGS_PATH = join(TMP, 'codebuddy-bridge-settings.json')
process.env.CODEBUDDY_SETTINGS_FILE = SETTINGS_PATH
const clean = () => { try { rmSync(SETTINGS_PATH, { force: true }) } catch (e) { } }
const writeRaw = (obj) => writeFileSync(SETTINGS_PATH, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')

// ── core 原语 ────────────────────────────────────────────────────────────────

const core = await import('../core/codebuddy-core.mjs')

test('core: 文件缺失 → readBridgeSettingsFile() === null（与「文件说默认值」可区分）', () => {
  clean()
  assert.equal(core.readBridgeSettingsFile(), null)
  assert.equal(core.readBridgeSettingsFile({ path: SETTINGS_PATH }), null)
})

test('core: CODEBUDDY_SETTINGS_FILE 覆盖定位；写→读往返一致', () => {
  clean()
  const snap = core.sanitizeBridgeSettings({ preferredBackend: 'workbuddy', defaultModel: 'hy4-preview', codebuddyEnToken: 'tok-1234567890abcd', endpointOverride: 'https://example.test/v2' })
  const w = core.writeBridgeSettingsFile(snap, {})
  assert.equal(w.ok, true)
  assert.equal(w.path, SETTINGS_PATH)
  const r = core.readBridgeSettingsFile()
  assert.equal(r.preferredBackend, 'workbuddy')
  assert.equal(r.defaultModel, 'hy4-preview')
  assert.equal(r.codebuddyEnToken, 'tok-1234567890abcd')
  assert.equal(r.endpointOverride, 'https://example.test/v2')
  assert.ok(Number(r.updatedAt) > 0)
})

test('core: 原子写不留 .tmp 残file；损坏 JSON → null；垃圾值清洗', () => {
  clean()
  core.writeBridgeSettingsFile(core.defaultBridgeSettings(), {})
  const leftovers = []
  // 目录里应只有设置文件本身（rename 成功路径不产生残留）
  const { readdirSync } = await_import_fs()
  for (const f of readdirSync(TMP)) if (f.endsWith('.tmp')) leftovers.push(f)
  assert.deepEqual(leftovers, [])
  writeRaw('{ not json')
  assert.equal(core.readBridgeSettingsFile(), null, '损坏文件 = 视同缺失')
  const cleaned = core.normalizeBridgeSettings({ preferredBackend: 'bogus', defaultModel: '  spaced  ', endpointOverride: 42 })
  assert.equal(cleaned.preferredBackend, 'codebuddy', '未知后端回落默认')
  // v1.3.3 别名清洗：workbuddy-en / workbuddy-ai → 规范 id codebuddy-en 落盘
  assert.equal(core.normalizeBridgeSettings({ preferredBackend: 'workbuddy-en' }).preferredBackend, 'codebuddy-en')
  assert.equal(core.sanitizeBridgeSettings({ preferredBackend: 'WorkBuddy-AI' }).preferredBackend, 'codebuddy-en')
  assert.equal(cleaned.defaultModel, 'spaced', 'trim')
  assert.equal(cleaned.endpointOverride, '', '非字符串丢弃')
  // sanitize 只挑四个已知字段
  const picked = core.sanitizeBridgeSettings({ preferredBackend: 'workbuddy', extraJunk: 'x', __proto__: {} })
  assert.equal(picked.extraJunk, undefined)
})

function await_import_fs() {
  return { readdirSync: core.readdirSyncForTest || require_readdir() }
}
function require_readdir() {
  // process.getBuiltinModule 在测试进程可用（Node ≥22）
  return core ? globalThis.process.getBuiltinModule('node:fs').readdirSync : null
}

test('core: writeBridgeSettingsFile rename 失败 → ok:false 且清理 tmp（io 注入）', () => {
  const dir = join(TMP, 'rwfail')
  let tmpCreated = null
  const io = {
    path: join(dir, 'nested', 'settings.json'),
    writeFileSync: (p) => { if (String(p).endsWith('.tmp')) tmpCreated = p; else writeFileSync(p, 'x') },
    renameSync: () => { throw new Error('EACCES simulated') },
    mkdirSync: () => { },
    rmSync: (p) => { if (p === tmpCreated) tmpCreated = null }
  }
  const w = core.writeBridgeSettingsFile({ preferredBackend: 'codebuddy' }, io)
  assert.equal(w.ok, false)
  assert.match(w.error, /EACCES/)
  assert.equal(tmpCreated, null, '失败的 .tmp 必须被 rmSync 清走')
})

test('core: backendSettingsMeta / diagnoseBackend（诊断视图纯函数）', () => {
  // 测试注入 io：模型清单来自夹具（真机态下为各安装的 product 描述文件）
  const io = { readFileSync: () => { throw new Error('fixture: no product.json') } }
  const metas = core.allBackendSettingsMeta(io)
  assert.deepEqual(metas.map((m) => m.id), ['codebuddy', 'codebuddy-intl', 'codebuddy-en', 'workbuddy'])
  // 夹具读不到 product 描述文件 → 回退静态表（回退表即真机实测值）
  assert.ok(metas[0].models.includes('glm-5.2'), 'codebuddy 回退表含真机型号')
  assert.ok(metas[1].models.includes('claude-sonnet-5'), 'codebuddy-intl 回退表含国际面型号')
  assert.equal(metas[2].needsToken, true)
  assert.equal(metas[0].needsToken, false)
  assert.ok(metas[3].models.includes('deepseek-v3-2-volc'), 'workbuddy 回退表')
  const diag = core.diagnoseBackend('codebuddy', core.defaultBridgeSettings(), { env: {} })
  // 测试夹具登录域 www.codebuddy.cn（mockdsh fixtures/auth）→ 端点应为 cn 域而非 product
  assert.equal(diag.endpointSource, 'auth-domain')
  assert.match(diag.endpoint, /^https:\/\/www\.codebuddy\.cn\/v2$/)
  const ov = core.diagnoseBackend('codebuddy', { endpointOverride: 'https://my.proxy/v2' }, { env: {} })
  assert.equal(ov.endpoint, 'https://my.proxy/v2')
  assert.equal(ov.endpointSource, 'override')
})

// ── indicator host：设置视图纯函数 ───────────────────────────────────────────

const indicator = await import('../home-plugin/codebuddy-indicator/lib/index.mjs')

test('host: maskToken 只回掩码；settingsView 无明文泄漏', () => {
  assert.deepEqual(indicator.maskToken(''), { set: false, hint: '' })
  assert.deepEqual(indicator.maskToken('short'), { set: true, hint: '••••' })
  const m = indicator.maskToken('secret-token-abcdef1234')
  assert.equal(m.set, true)
  assert.equal(m.hint, '••••1234')
  clean()
  core.writeBridgeSettingsFile(core.sanitizeBridgeSettings({ preferredBackend: 'codebuddy-en', codebuddyEnToken: 'secret-token-abcdef1234' }), {})
  const v = indicator.settingsView({})
  assert.equal(v.persisted, true)
  assert.equal(v.preferredBackend, 'codebuddy-en')
  assert.equal(v.diagnostics.length, 4)
  assert.equal(v.backends.length, 4)
  assert.ok(!JSON.stringify(v).includes('secret-token'), 'GET 视图绝不回传 token 明文')
})

test('host: parseSettingsBody 校验面（JSON 错误/非对象/字段类型/未知键丢弃）', () => {
  assert.equal(indicator.parseSettingsBody('').ok, false)
  assert.equal(indicator.parseSettingsBody('{oops').ok, false)
  assert.equal(indicator.parseSettingsBody('[1,2]').ok, false)
  assert.equal(indicator.parseSettingsBody('{"preferredBackend":7}').ok, false)
  const ok = indicator.parseSettingsBody('{"preferredBackend":"workbuddy","junkKey":"x"}')
  assert.equal(ok.ok, true)
  assert.equal(ok.value.preferredBackend, 'workbuddy')
  assert.equal(ok.value.junkKey, undefined, '未知键不进文件')
})

// ── indicator host：GET/POST 路由端到端 ──────────────────────────────────────

function mountRoutes() {
  const handlers = Object.create(null)
  const registered = []
  let injectCb = null
  const ctx = {
    on: (n, cb) => { handlers[n] = cb },
    provide: () => { },
    inject: (deps, cb) => { injectCb = cb },
    get: () => undefined
  }
  indicator.apply(ctx)
  const ws = { register: (r) => { registered.push(r); return () => { } } }
  injectCb({ get: () => ws, effect: (fn) => { fn(); return () => { } } })
  const route = registered.find((r) => r.path === '/codebuddy-indicator/settings')
  assert.ok(route, 'settings 路由已注册')
  return route.handler
}

function callRoute(handler, method, bodyText) {
  return new Promise((resolve) => {
    const req = new Readable({ read() { } })
    req.method = method
    const res = {
      code: 0,
      headers: null,
      writeHead(c, h) { res.code = c; res.headers = h },
      end(b) { resolve({ code: res.code, json: b ? JSON.parse(b) : null }) }
    }
    if (bodyText != null) req.push(bodyText)
    req.push(null)
    handler(req, res)
  })
}

test('host: 路由 GET → 视图 JSON；未保存过时 persisted:false', async () => {
  clean()
  const h = mountRoutes()
  const r = await callRoute(h, 'GET')
  assert.equal(r.code, 200)
  assert.equal(r.json.persisted, false)
  assert.equal(r.json.preferredBackend, 'codebuddy')
  assert.deepEqual(r.json.codebuddyEnToken, { set: false, hint: '' })
  assert.equal(r.json.diagnostics.length, 4)
})

test('host: POST 写入 → GET 读回；非法体 400；非 GET/POST 405', async () => {
  clean()
  const h = mountRoutes()
  let r = await callRoute(h, 'POST', '{"preferredBackend":"workbuddy","defaultModel":"glm-5.3"}')
  assert.equal(r.code, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.settings.preferredBackend, 'workbuddy')
  const onDisk = core.readBridgeSettingsFile()
  assert.equal(onDisk.preferredBackend, 'workbuddy')
  assert.equal(onDisk.defaultModel, 'glm-5.3')
  r = await callRoute(h, 'POST', 'not json')
  assert.equal(r.code, 400)
  r = await callRoute(h, 'PUT', '{}')
  assert.equal(r.code, 405)
})

test('host: token 语义 — 缺省保持现值 / codebuddyEnTokenClear 显式清除', async () => {
  clean()
  const h = mountRoutes()
  await callRoute(h, 'POST', '{"preferredBackend":"codebuddy-en","codebuddyEnToken":"tok-abcdef999888777"}')
  assert.equal(core.readBridgeSettingsFile().codebuddyEnToken, 'tok-abcdef999888777')
  // 之后再存别的字段，不带 token → 保持
  await callRoute(h, 'POST', '{"preferredBackend":"codebuddy-en","defaultModel":"auto"}')
  assert.equal(core.readBridgeSettingsFile().codebuddyEnToken, 'tok-abcdef999888777', '缺省 = 保持')
  // 显式清除
  await callRoute(h, 'POST', '{"preferredBackend":"codebuddy-en","codebuddyEnTokenClear":true}')
  assert.equal(core.readBridgeSettingsFile().codebuddyEnToken, '')
})

// ── preset 形态：面板保存的热生效 ────────────────────────────────────────────

let presetN = 0
async function loadPresetFresh() {
  return import('../preset/codebuddy-first/codebuddy-first-bridge.mjs?fresh=' + (++presetN))
}

test('preset：设置文件每次调用现读 —— 保存后无需重启即改变派发', async () => {
  clean()
  const mod = await loadPresetFresh()
  const sub = createMockSubprocess(() => ({ stdout: successStream(), exitCode: 0 }))
  const mc = createMockCtx({})
  mc.ctx.subprocess = sub.subprocess
  mod.apply(mc.ctx, {})
  // apply 后（面板式）写文件：workbuddy + 默认模型
  core.writeBridgeSettingsFile(core.sanitizeBridgeSettings({ preferredBackend: 'workbuddy', defaultModel: 'glm-5.3' }), {})
  const run = mc.registeredTools.find((t) => t.name === 'codebuddy_run')
  await run.execute({ prompt: 'x', cwd: 'C:\\projS' }, { agent: 'a1' })
  const argv = sub.spawns[0].argv.join(' ')
  assert.ok(argv.includes('WorkBuddy'), 'workbuddy CLI 路径生效：' + argv)
  assert.ok(argv.includes('--model') && argv.includes('glm-5.3'), '默认模型注入 argv')
  // 再改回 codebuddy → 下一次调用即切换（无重启）
  core.writeBridgeSettingsFile(core.sanitizeBridgeSettings({ preferredBackend: 'codebuddy' }), {})
  await run.execute({ prompt: 'y', cwd: 'C:\\projS' }, { agent: 'a1' })
  assert.ok(!sub.spawns[1].argv.join(' ').includes('WorkBuddy'), '切回国内 npm CLI')
})

test('preset：设置文件优先于行 config（旧 patch 行不吞面板保存）', async () => {
  clean()
  const mod = await loadPresetFresh()
  const sub = createMockSubprocess(() => ({ stdout: successStream(), exitCode: 0 }))
  const mc = createMockCtx({})
  mc.ctx.subprocess = sub.subprocess
  // 行 config 说 codebuddy，文件说 workbuddy → 文件赢
  mod.apply(mc.ctx, { preferredBackend: 'codebuddy', defaultModel: 'row-model' })
  core.writeBridgeSettingsFile(core.sanitizeBridgeSettings({ preferredBackend: 'workbuddy', defaultModel: 'file-model' }), {})
  const run = mc.registeredTools.find((t) => t.name === 'codebuddy_run')
  await run.execute({ prompt: 'x', cwd: 'C:\\projF' }, { agent: 'a1' })
  const argv = sub.spawns[0].argv.join(' ')
  assert.ok(argv.includes('WorkBuddy'), '文件后端生效')
  assert.ok(argv.includes('file-model') && !argv.includes('row-model'), '文件模型生效')
})

test('preset：文件缺失时行 config 仍生效（旧部署兼容）', async () => {
  clean()
  const mod = await loadPresetFresh()
  const sub = createMockSubprocess(() => ({ stdout: successStream(), exitCode: 0 }))
  const mc = createMockCtx({})
  mc.ctx.subprocess = sub.subprocess
  mod.apply(mc.ctx, { preferredBackend: 'workbuddy', defaultModel: 'row-only' })
  const run = mc.registeredTools.find((t) => t.name === 'codebuddy_run')
  await run.execute({ prompt: 'x', cwd: 'C:\\projR' }, { agent: 'a1' })
  const argv = sub.spawns[0].argv.join(' ')
  assert.ok(argv.includes('WorkBuddy'), '无文件 → 行 config 回退')
  assert.ok(argv.includes('row-only'))
})

// ── client 半：settings.section 注册 + 组件烟测（假 react，不触网）────────────

test('client：注册 settings.section（id/order/label）且加载 id 仍等于包名', async () => {
  const src = readFileSync(new URL('../home-plugin/codebuddy-indicator/lib/client.js', import.meta.url), 'utf8')
  const reactStub = {
    createElement: (type, props, ...children) => ({ type: typeof type === 'function' ? type.name : type, props: props || {}, children: children.flat(Infinity) }),
    Fragment: 'Fragment',
    useState: (init) => [typeof init === 'function' ? init() : init, () => { }],
    useEffect: () => { },
    useCallback: (fn) => fn,
    useSyncExternalStore: (sub, get) => get()
  }
  let loaded = null
  const fakeWindow = { __ModuleLoader__: { load: (m) => { loaded = m } } }
  // document 传 undefined → CSS 注入分支自然跳过（typeof 守卫）
  new Function('window', 'document', src)(fakeWindow, undefined)
  assert.ok(loaded, '__ModuleLoader__.load 被调用')
  assert.equal(loaded.id, 'codebuddy-first-bridge', '加载 id 必须等于包名（事故回归锁）')
  const exportsMod = loaded.factory((name) => {
    assert.equal(name, 'react', 'client 只 require react')
    return reactStub
  })
  assert.deepEqual(exportsMod.inject, ['slots'], 'client 注入依赖 = slots')
  // 挂 apply：捕获 slots 注册
  const regs = []
  const slotsSvc = {
    inject: (slotName, fn) => { assert.ok(slotName === 'settings.section' || slotName === 'conversation.session.header.utilities'); fn() },
    register: (opts, Comp) => { regs.push({ opts, Comp }); return () => { } }
  }
  exportsMod.apply({ inject: (deps, cb) => cb({ get: (n) => (n === 'slots' ? slotsSvc : undefined), slots: slotsSvc }) })
  const sec = regs.find((r) => r.opts.name === 'settings.section')
  assert.ok(sec, 'settings.section 分区已注册')
  assert.equal(sec.opts.id, 'codebuddy-bridge-settings')
  assert.equal(sec.opts.order, 7, '排在 general(0)/bot-gateway(5)/mobile-companion(6) 之后')
  assert.equal(typeof sec.opts.label, 'function', 'label 必须是 thunk（locale 读时解析）')
  assert.match(String(sec.opts.label()), /CodeBuddy/)
  // 组件烟测：假 react 下渲染「加载设置…」分支，不触网不抛错
  const tree = sec.Comp({})
  assert.ok(tree && tree.props.className === 'cbs-root')
  assert.ok(JSON.stringify(tree.children).includes('加载设置') || JSON.stringify(tree.children).includes('读取失败'),
    '首帧为加载态（view 未就位）')
})

process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch (e) { } })
