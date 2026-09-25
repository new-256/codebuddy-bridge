// test/core.test.mjs — 共享核心的纯函数 + 状态引擎 + 行流单测。
// 覆盖关键回归位：非 SUCCESS 失败后全局状态不抛错、半行拼接、
// LIMIT_RE 词边界与匹配面收窄、summarizeArgs 无损 JSON、按项目用量累计、
// 会话感知 cwd 回落、MRU 淘汰。

import test from 'node:test'
import assert from 'node:assert/strict'
import { isolateHostState } from './helpers/mockdsh.mjs'
import {
  isLimited, clampInt, shortLabel, summarizeArgs, parseCodebuddyJson, buildResult,
  buildArgv, fallbackResult, createLineStream, createStatusEngine, renderResult, renderStatus,
  isTransientCliError, failureHint, buildMcpBridgePayload, normalizeMcpBridge, MCP_BRIDGE_FILE,
  BACKENDS, DEFAULT_BACKEND, isBackend, normalizeBackend, resolveBackend, resolveEndpoint, endpointEnv,
  endpointMismatchHint, endpointHost, BACKEND_ENDPOINTS, AUTH_DOMAIN_ENDPOINTS, BACKEND_AUTH_IDS,
  BACKEND_LABELS, BACKEND_ALIASES,
  extractModelIds, readBackendModelCatalog, backendModelCatalog, parseAccountModels, BACKEND_MODEL_IDS,
  parseCreditValue, extractModelCredits, formatCreditLabel, modelCatalogDetailed, formatModelCatalogText,
  backendSettingsMeta, lookupModelCredits, rememberAccountCatalog, getAccountCatalog,
  normalizeProductConfig, extractModelPromotions, isPromotionActive, activePromotionFor,
  resolveEnToken, readDshWorkbuddyToken
} from '../core/codebuddy-core.mjs'

// 真机状态隔离：core 会读 DSH_HOME 凭据库（codebuddy-en 的 token 回退）。
// 必须在任何调用前执行，否则用例会命中本机真实凭据。
isolateHostState()

// ── clampInt / shortLabel / summarizeArgs ────────────────────────────────────

test('clampInt clamps and defaults', () => {
  assert.equal(clampInt(undefined, 300, 10, 3600), 300)
  assert.equal(clampInt('abc', 5, 1, 9), 5)
  assert.equal(clampInt(3, 300, 10, 3600), 10)
  assert.equal(clampInt(99999, 300, 10, 3600), 3600)
  assert.equal(clampInt('42', 300, 10, 3600), 42)
})

test('shortLabel truncates long prompts', () => {
  assert.equal(shortLabel('hi'), 'hi')
  const long = 'x'.repeat(200)
  assert.equal(shortLabel(long).length, 80)
  assert.ok(shortLabel(long).endsWith('...'))
})

test('summarizeArgs is lossless JSON (skips undefined, truncates long strings)', () => {
  assert.equal(summarizeArgs(null), null)
  const out = summarizeArgs({ a: 1, b: undefined, c: 'ok', d: 'y'.repeat(300) })
  assert.deepEqual(Object.keys(out).sort(), ['a', 'c', 'd'])
  assert.ok(out.d.length < 130 && out.d.endsWith('…'))
  // 无损 JSON 契约：结果必须可被 JSON.stringify（无 undefined 字段值）。
  assert.doesNotThrow(() => JSON.stringify(out))
})

// ── parseCodebuddyJson / buildResult ─────────────────────────────────────────

test('parseCodebuddyJson finds the LAST result line and tolerates junk', () => {
  const stream = [
    'starting up',
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
    'trailing log line'
  ].join('\n')
  const parsed = parseCodebuddyJson(stream)
  assert.equal(parsed.type, 'result')
  assert.equal(parseCodebuddyJson(''), null)
  assert.equal(parseCodebuddyJson('not json at all'), null)
  // 整体 JSON 兜底
  const whole = parseCodebuddyJson(JSON.stringify({ type: 'result', subtype: 'success' }))
  assert.equal(whole.subtype, 'success')
})

test('buildResult maps success / failure / parse-error', () => {
  const okRes = buildResult(
    { type: 'result', subtype: 'success', is_error: false, result: 'answer', session_id: 's1', duration_ms: 2000, num_turns: 2, usage: { input_tokens: 7, output_tokens: 3 } },
    { exitCode: 0 }, 'bypassPermissions', '', '')
  assert.equal(okRes.ok, true)
  assert.equal(okRes.status, 'SUCCESS')
  assert.equal(okRes.sessionId, 's1')
  assert.equal(okRes.durationSeconds, 2)
  assert.equal(okRes.totalTokens, 10)

  const errRes = buildResult(
    { type: 'result', subtype: 'error_during_execution', is_error: true, error: 'boom 429', session_id: 's2' },
    { exitCode: 1 }, 'bypassPermissions', 'stderr tail', '')
  assert.equal(errRes.ok, false)
  assert.equal(errRes.status, 'ERROR_DURING_EXECUTION')
  assert.ok(errRes.stderr.includes('stderr tail') && errRes.stderr.includes('boom 429'))

  const parseRes = buildResult(null, { exitCode: 1 }, 'plan', 'some stderr', 'raw out')
  assert.equal(parseRes.ok, false)
  assert.equal(parseRes.status, 'PARSE_ERROR')
  assert.equal(parseRes.rawStdout, 'raw out')
})

// ── buildArgv ────────────────────────────────────────────────────────────────

test('buildArgv resolves modes and passes through prefix/options', () => {
  const base = { prompt: 'do it' }
  // auto + planActive=false → bypassPermissions
  let b = buildArgv(['codebuddy'], base, { defaultMode: 'auto', planActive: false })
  assert.equal(b.mode, 'bypassPermissions')
  assert.deepEqual(b.argv.slice(0, 6), ['codebuddy', '-p', 'do it', '--output-format', 'stream-json', '--permission-mode'])
  assert.equal(b.argv[6], 'bypassPermissions')
  assert.equal(b.timeoutSec, 300)
  // auto + planActive=true → plan
  b = buildArgv(['codebuddy'], base, { defaultMode: 'auto', planActive: true })
  assert.equal(b.mode, 'plan')
  assert.equal(b.argv[6], 'plan')
  // plan 显式
  b = buildArgv(['codebuddy'], { ...base, mode: 'plan' }, { defaultMode: 'auto' })
  assert.equal(b.mode, 'plan')
  // accept-edits（MCP 默认）→ bypassPermissions
  b = buildArgv(['node', 'bin/codebuddy'], { ...base, mode: 'accept-edits' }, { defaultMode: 'accept-edits' })
  assert.equal(b.mode, 'bypassPermissions')
  assert.deepEqual(b.argv.slice(0, 2), ['node', 'bin/codebuddy'])
  // 可选项 + 续接
  b = buildArgv(['codebuddy'], { ...base, model: 'hy3', effort: 'high', maxTurns: 12, addDirs: ['d1', ''], timeoutSec: 5000, sessionId: 's-9' }, {})
  const j = b.argv.join(' ')
  assert.ok(j.includes('--model hy3') && j.includes('--effort high') && j.includes('--max-turns 12'))
  assert.ok(j.includes('--add-dir d1') && !j.includes('--add-dir  '))
  assert.ok(j.includes('--resume s-9'))
  assert.equal(b.timeoutSec, 3600) // clamp 上限
  // continueLatest → --continue
  b = buildArgv(['codebuddy'], { ...base, continueLatest: true }, {})
  assert.ok(b.argv.includes('--continue'))
})

test('buildArgv: plan 模式预批 Bash（v1.1.3）—— 非交互下只读 shell 可用，bypass 模式不加白名单', () => {
  const base = { prompt: 'investigate' }
  // plan：CLI 在 -p 非交互下默认拒 Bash（报「未获授权」并绕道 PowerShell），
  // 预批后只读 shell 调查恢复；写入仍由 plan 模式独立禁止。
  let b = buildArgv(['codebuddy'], { ...base, mode: 'plan' }, {})
  const i = b.argv.indexOf('--allowedTools')
  assert.ok(i > 0, 'plan 模式必须带 --allowedTools')
  assert.equal(b.argv[i + 1], 'Bash')
  assert.ok(b.argv.includes('--permission-mode') && b.argv[b.argv.indexOf('--permission-mode') + 1] === 'plan', 'plan 门禁仍在')
  // auto + planActive=true 走同一条路径
  b = buildArgv(['codebuddy'], base, { defaultMode: 'auto', planActive: true })
  assert.ok(b.argv.includes('--allowedTools'))
  // bypassPermissions 本就不受门禁影响，不必加白名单（避免收窄工具面的误解）
  b = buildArgv(['codebuddy'], base, { defaultMode: 'auto', planActive: false })
  assert.equal(b.mode, 'bypassPermissions')
  assert.ok(!b.argv.includes('--allowedTools'), 'bypass 模式不加 --allowedTools')
})

// ── isLimited（词边界 + 匹配面收窄）────────────────────────────

test('isTransientCliError / failureHint（v1.1.4）—— CLI 瞬时错误可自动重试且自带指引', () => {
  // codebuddy 自己报 error_during_execution，且不给任何原因（result/stderr 全空）
  const t = { ok: false, status: 'ERROR_DURING_EXECUTION', response: '', stderr: '' }
  assert.equal(isTransientCliError(t), true)
  assert.match(failureHint(t), /直接重试同一请求/)
  // 已自动重试过 → 指引改口径，提示换 model 或改用原生工具
  assert.match(failureHint({ ...t, retried: true }), /已自动重试 1 次仍失败/)
  // 成功结果没有指引
  assert.equal(isTransientCliError({ ok: true, status: 'SUCCESS' }), false)
  assert.equal(failureHint({ ok: true, status: 'SUCCESS' }), '')
  // 限流类不归瞬时错误（要问用户，重试可能纯烧钱）
  const limited = { ok: false, status: 'ERROR_DURING_EXECUTION', stderr: 'HTTP 429 too many requests' }
  assert.equal(isLimited(limited), true)
  assert.equal(isTransientCliError(limited), false, '限流优先，不走静默重试')
  // 其他失败态不误判
  assert.equal(isTransientCliError({ ok: false, status: 'ERROR' }), false)
  assert.equal(isTransientCliError({ ok: false, status: 'HUNG_TIMEOUT' }), false)
  assert.match(failureHint({ ok: false, status: 'PARSE_ERROR' }), /未能.*解析出 result 事件/)
})

test('buildResult: 记录实际使用的模型（v1.1.4）—— 排查默认模型不必靠猜', () => {
  const parsed = {
    type: 'result', subtype: 'success', is_error: false, result: 'done',
    session_id: 's1', duration_ms: 1000, num_turns: 2,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: { 'hy4-preview': { outputTokens: 864, contextWindow: 1000000 } }
  }
  const r = buildResult(parsed, { exitCode: 0 }, 'bypassPermissions', '', '', 'codebuddy')
  assert.equal(r.modelUsed, 'hy4-preview')
  // 只取键名字符串，不把 modelUsage 下的对象带进结果（通道要求可无损 JSON 化）
  assert.equal(typeof r.modelUsed, 'string')
  assert.equal(JSON.parse(JSON.stringify(r)).modelUsed, 'hy4-preview')
  // head 里带上 model，失败时还带 retried 标记
  assert.match(renderResult(r)[0].text, /model=hy4-preview/)
  const failed = { ok: false, status: 'ERROR_DURING_EXECUTION', mode: 'bypassPermissions', backend: 'codebuddy', modelUsed: 'hy4-preview', retried: true, response: '', stderr: '' }
  const txt = renderResult(failed)[0].text
  assert.match(txt, /retried=1/)
  assert.match(txt, /已自动重试 1 次仍失败/, '失败必须带可行动指引，不能只有一行 head')
  // 无 modelUsage 时字段为 null，不影响渲染
  const r2 = buildResult({ ...parsed, modelUsage: undefined }, { exitCode: 0 }, 'plan', '', '', 'codebuddy')
  assert.equal(r2.modelUsed, null)
  assert.ok(!renderResult(r2)[0].text.includes('model='))
})

test('isLimited: status short-circuits', () => {
  assert.equal(isLimited({ ok: true, status: 'SUCCESS' }), false)
  assert.equal(isLimited(null), false)
  for (const s of ['SPAWN_ERROR', 'CODEBUDDY_UNAVAILABLE', 'HUNG_TIMEOUT']) {
    assert.equal(isLimited({ ok: false, status: s }), true, s)
  }
})

test('isLimited: stderr hits', () => {
  assert.equal(isLimited({ ok: false, status: 'ERROR', stderr: 'HTTP 429 too many requests' }), true)
  assert.equal(isLimited({ ok: false, status: 'ERROR', stderr: 'ECONNRESET: socket hang up' }), true)
  assert.equal(isLimited({ ok: false, status: 'ERROR', stderr: 'server returned 503' }), true)
  assert.equal(isLimited({ ok: false, status: 'ERROR', stderr: '401 unauthorized' }), true)
})

test('isLimited: 回复全文不再参与匹配', () => {
  // 排查网络类任务的答复里出现这些词是常态，不应误判为限流。
  const res = { ok: false, status: 'ERROR', stderr: '', response: 'The connection was reset because the dns lookup timed out; check your proxy settings and retry' }
  assert.equal(isLimited(res), false)
})

test('isLimited: 数字码词边界 — "1500" 不命中 500、"4013" 不命中 401', () => {
  assert.equal(isLimited({ ok: false, status: 'ERROR', stderr: 'wrote 1500 bytes' }), false)
  assert.equal(isLimited({ ok: false, status: 'ERROR', stderr: 'port 4013 open' }), false)
  assert.equal(isLimited({ ok: false, status: 'ERROR', stderr: 'exit code 500' }), true)
})

// ── fallbackResult ───────────────────────────────────────────────────────────

test('fallbackResult marks FALLBACK_TO_DSH with reason passthrough', () => {
  const f = fallbackResult({ sessionId: 's1', exitCode: 1, stderr: 'x', status: 'ERROR' }, 'plan')
  assert.equal(f.fallback, true)
  assert.equal(f.status, 'FALLBACK_TO_DSH')
  assert.equal(f.sessionId, 's1')
  assert.equal(f.reason, 'ERROR')
})

// ── createLineStream（跨 chunk 半行）─────────────────────────

test('createLineStream stitches lines split across chunks and flushes the tail', () => {
  const got = []
  const s = createLineStream((ln) => got.push(ln))
  s.pushChunk('{"type":"assistant","mess')
  assert.equal(got.length, 0) // 半行不派发
  s.pushChunk('age":{"content":[{"type":"text","text":"hi"}]}}\n{"half')
  assert.equal(got.length, 1)
  assert.equal(JSON.parse(got[0]).type, 'assistant')
  s.pushChunk('tail"}\n')
  assert.equal(got.length, 2)
  assert.equal(got[1], '{"halftail"}')
  // flush 残余（无换行结尾的最后一行）
  s.pushChunk('{"last":"no-newline"}')
  assert.equal(got.length, 2)
  s.flush()
  assert.equal(got.length, 3)
  assert.equal(got[2], '{"last":"no-newline"}')
  // 空串安全 + 二次 flush 无副作用
  s.pushChunk('')
  s.flush()
  assert.equal(got.length, 3)
})

test('createLineStream handles CRLF', () => {
  const got = []
  const s = createLineStream((ln) => got.push(ln))
  s.pushChunk('a\r\nb\r\n')
  assert.deepEqual(got, ['a', 'b'])
})

// ── createStatusEngine ───────────────────────────────────────────────────────

test('engine: P0 回归 — 非 SUCCESS 结束后快照不抛错且状态为 failed', () => {
  const eng = createStatusEngine(null)
  eng.begin('/p/a')
  eng.end({ ok: false, status: 'ERROR', sessionId: 's1' }, '/p/a')
  let snap
  assert.doesNotThrow(() => { snap = eng.statusSnapshot() })
  assert.equal(snap.state, 'failed')
  assert.equal(snap.lastStatus, 'ERROR')
  assert.equal(snap.runs, 1)
})

test('engine: success → ok; fallback 粘住 fallback 态', () => {
  const eng = createStatusEngine(null)
  eng.begin('/p/a')
  eng.end({ ok: true, status: 'SUCCESS', sessionId: 's1', totalTokens: 100 }, '/p/a')
  assert.equal(eng.statusSnapshot().state, 'ok')
  eng.begin('/p/a')
  eng.end({ ok: false, fallback: true, status: 'FALLBACK_TO_DSH' }, '/p/a')
  const snap = eng.statusSnapshot()
  assert.equal(snap.state, 'fallback')
  assert.equal(snap.fallbackActive, true)
})

test('engine: 用量累计 runs/totalTokens（含 fallback 无 token 的 run）', () => {
  const eng = createStatusEngine(null)
  eng.end({ ok: true, status: 'SUCCESS', totalTokens: 100 }, '/p/a')
  eng.end({ ok: true, status: 'SUCCESS', totalTokens: 50 }, '/p/a')
  eng.end({ ok: false, fallback: true, status: 'FALLBACK_TO_DSH' }, '/p/a')
  eng.end({ ok: false, status: 'ERROR' }, '/p/b') // 另一项目
  const snap = eng.statusSnapshot()
  assert.equal(snap.runs, 4)
  assert.equal(snap.totalTokens, 150)
  const a = snap.projects.find((p) => p.cwd === '/p/a')
  assert.equal(a.runs, 3)
  assert.equal(a.totalTokens, 150)
})

test('engine: foldEvent 折叠 tool_use / tool_result / thinking（args 无损）', () => {
  const eng = createStatusEngine(null)
  eng.foldEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'x.ts' } }] } }, '/p/a')
  eng.foldEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }, '/p/a')
  eng.foldEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }, '/p/a')
  const p = eng.projects['/p/a']
  assert.equal(p.trail.length, 2)
  assert.equal(p.trail[0].tool, 'Edit')
  assert.equal(p.trail[0].state, 'ACTIVE')
  assert.equal(p.trail[0].args.file_path, 'x.ts')
  assert.equal(p.trail[1].state, 'ERROR') // is_error → ERROR
  assert.equal(p.trail[1].args, null)     // tool_result args=null（无损 JSON 契约）
  assert.equal(p.current.tool, 'thinking')
  assert.doesNotThrow(() => JSON.stringify(eng.statusSnapshot()))
})

test('engine: resolveCwd 会话感知回落', () => {
  const eng = createStatusEngine(null)
  eng.end({ ok: true, status: 'SUCCESS', sessionId: 's-77' }, '/proj/A')
  eng.end({ ok: true, status: 'SUCCESS', sessionId: 's-88' }, '/proj/B')
  // 两次 end 可能落在同一毫秒：显式保证 B 更新（continueLatest 取最近）。
  eng.projects['/proj/B'].updatedAt = Date.now() + 1000
  // 显式 cwd 优先
  assert.equal(eng.resolveCwd({ cwd: '/explicit' }, '/fallback'), '/explicit')
  // sessionId 命中 → 该项目 cwd
  assert.equal(eng.resolveCwd({ sessionId: 's-77' }, '/fallback'), '/proj/A')
  // 未命中 → fallback
  assert.equal(eng.resolveCwd({ sessionId: 'nope' }, '/fallback'), '/fallback')
  // continueLatest → 最近有 session 的项目（B 比 A 新）
  assert.equal(eng.resolveCwd({ continueLatest: true }, '/fallback'), '/proj/B')
  // 无 session 语义 → fallback
  assert.equal(eng.resolveCwd({}, '/fallback'), '/fallback')
})

test('engine: resolveTarget 后端路由—— 同项目混用两个后端时按会话归属路由', () => {
  const eng = createStatusEngine(null)
  // 同一个项目先跑 codebuddy 再跑 workbuddy（项目级 lastBackend 会是 workbuddy）
  eng.end({ ok: true, status: 'SUCCESS', sessionId: 'cb-s1', backend: 'codebuddy' }, '/proj/A')
  eng.end({ ok: true, status: 'SUCCESS', sessionId: 'wb-s1', backend: 'workbuddy' }, '/proj/A')
  eng.projects['/proj/A'].updatedAt = Date.now() + 1000
  // 显式 backend 不由 resolveTarget 处理（runner 层职责），此处返回会话推导值
  assert.deepEqual(eng.resolveTarget({ backend: 'workbuddy' }, '/fb'), { cwd: '/fb', backend: null })
  // cb-s1 是 codebuddy 会话 → 即使项目 lastBackend 已是 workbuddy，也路由回 codebuddy
  assert.deepEqual(eng.resolveTarget({ sessionId: 'cb-s1' }, '/fb'), { cwd: '/proj/A', backend: 'codebuddy' })
  // wb-s1 → workbuddy
  assert.deepEqual(eng.resolveTarget({ sessionId: 'wb-s1' }, '/fb'), { cwd: '/proj/A', backend: 'workbuddy' })
  // continueLatest → 最近项目 + 其后端（workbuddy）
  assert.deepEqual(eng.resolveTarget({ continueLatest: true }, '/fb'), { cwd: '/proj/A', backend: 'workbuddy' })
  // 未知会话 / 无语义 → backend null（调用方取默认）
  assert.deepEqual(eng.resolveTarget({ sessionId: 'nope' }, '/fb'), { cwd: '/fb', backend: null })
  assert.deepEqual(eng.resolveTarget({}, '/fb'), { cwd: '/fb', backend: null })
  // 快照含 lastBackend
  const snap = eng.statusSnapshot()
  assert.equal(snap.projects[0].lastBackend, 'workbuddy')
  assert.equal(snap.lastBackend, 'workbuddy')
})

test('buildResult/fallbackResult/renderResult：backend 贯通', () => {
  const parsed = { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'wb-9', duration_ms: 1000, num_turns: 1, usage: { input_tokens: 3, output_tokens: 4 } }
  const r = buildResult(parsed, { exitCode: 0 }, 'bypassPermissions', '', '', 'workbuddy')
  assert.equal(r.backend, 'workbuddy')
  assert.equal(r.totalTokens, 7)
  const r2 = buildResult(null, { exitCode: 1 }, 'bypassPermissions', 'x', 'y')
  assert.equal(r2.backend, 'codebuddy')
  const fb = fallbackResult({ status: 'ERROR', backend: 'workbuddy' }, 'bypassPermissions')
  assert.equal(fb.backend, 'workbuddy')
  // 渲染头部用 backend 名
  const out = renderResult(r)
  assert.ok(out[0].text.startsWith('workbuddy OK [status=SUCCESS'), out[0].text)
  const out2 = renderResult({ ok: true, status: 'SUCCESS', mode: 'plan', response: 'x' })
  assert.ok(out2[0].text.startsWith('codebuddy OK '), out2[0].text)
  // 状态渲染的 workbuddy 标记
  const st = renderStatus({ state: 'ok', running: 0, projects: [{ cwd: '/p/a', name: 'a', state: 'ok', running: 0, current: null, trail: [], lastStatus: 'SUCCESS', lastAt: 1, lastSessionId: 's1', lastBackend: 'workbuddy', runs: 1, totalTokens: 7, updatedAt: 1 }], runs: 1, totalTokens: 7 })
  assert.ok(st[0].text.includes('[workbuddy]'), st[0].text)
})

test('engine: MRU 淘汰 — 上限 12 项目，优先淘汰空闲中最久未活跃的', () => {
  const eng = createStatusEngine(null)
  for (let i = 0; i < 12; i++) {
    eng.end({ ok: true, status: 'SUCCESS' }, '/p/' + i)
  }
  assert.equal(Object.keys(eng.projects).length, 12)
  assert.ok(eng.projects['/p/0']) // 第一个还在
  eng.end({ ok: true, status: 'SUCCESS' }, '/p/new') // 触发淘汰 /p/0（最旧空闲）
  assert.equal(Object.keys(eng.projects).length, 12)
  assert.ok(!eng.projects['/p/0'])
  assert.ok(eng.projects['/p/new'])
})

test('engine: publish 回调在 begin/end/foldEvent 后触发', () => {
  const pushes = []
  const eng = createStatusEngine({ publish: (snap) => pushes.push(snap.state) })
  eng.begin('/p/a')
  eng.end({ ok: true, status: 'SUCCESS' }, '/p/a')
  assert.deepEqual(pushes, ['running', 'ok'])
})

test('engine: 全局聚合 — running 求和、lastAt 取最新', () => {
  const eng = createStatusEngine(null)
  eng.begin('/p/a')
  eng.begin('/p/b')
  eng.end({ ok: true, status: 'SUCCESS', sessionId: 'sA' }, '/p/a')
  const snap = eng.statusSnapshot()
  assert.equal(snap.running, 1)
  assert.equal(snap.lastSessionId, 'sA')
})

// ── renderers ────────────────────────────────────────────────────────────────

test('renderResult / renderStatus 产出无损文本', () => {
  const r = renderResult({ ok: true, status: 'SUCCESS', mode: 'bypassPermissions', sessionId: 's1', totalTokens: 15, durationSeconds: 2, response: 'done' })
  assert.ok(r[0].text.includes('codebuddy OK [status=SUCCESS mode=bypassPermissions session=s1 tokens=15 2s]'))
  assert.ok(r[0].text.includes('done'))
  const fb = renderResult({ fallback: true, reason: 'ERROR' })
  assert.ok(fb[0].text.includes('回退') && fb[0].text.includes('ERROR'))
  const st = renderStatus({ state: 'ok', running: 0, projects: [{ cwd: '/p/a', name: 'a', state: 'ok', running: 0, current: null, trail: [], lastStatus: 'SUCCESS', lastAt: 1, lastSessionId: 's1', runs: 2, totalTokens: 15, updatedAt: 1 }], runs: 2, totalTokens: 15 })
  assert.ok(st[0].text.includes('total 2 runs, 15 tokens'))
})

// ── MCP → 家级插件快照文件通道（v1.1.5）─────────────────────────────────────

test('buildMcpBridgePayload: 收窄为可无损 JSON 化的叶子字段', () => {
  const snap = {
    state: 'running', running: 1,
    projects: [{
      cwd: 'C:\\proj', name: 'proj', state: 'running', running: 1,
      current: { stepIndex: 3, tool: 'Bash', args: { command: 'ls' } },
      trail: [{ stepIndex: 1, tool: 'Read', state: 'done', args: null }],
      lastStatus: 'SUCCESS', lastAt: 5, lastSessionId: 's1', lastBackend: 'codebuddy',
      fallbackActive: false, runs: 2, totalTokens: 100, updatedAt: 7
    }]
  }
  const p = buildMcpBridgePayload(snap, 4242, 999)
  assert.equal(p.source, 'mcp')
  assert.equal(p.pid, 4242)
  assert.equal(p.updatedAt, 999)
  assert.equal(p.projects[0].cwd, 'C:\\proj')
  assert.equal(p.projects[0].current.tool, 'Bash')
  assert.equal(p.projects[0].runs, 2)
  // 必须能无损 JSON 往返（要写文件）
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p)
  // 无 cwd 的条目丢弃；空输入安全
  assert.equal(buildMcpBridgePayload({ projects: [{ running: 1 }] }, 1, 1).projects.length, 0)
  assert.equal(buildMcpBridgePayload(null, 0, 0).projects.length, 0)
  assert.equal(MCP_BRIDGE_FILE, 'codebuddy-indicator-mcp.json')
})

test('renderStatus: 合计记号为纯 ASCII（不再用希腊字母 Σ）', () => {
  const txt = renderStatus({
    state: 'ok', running: 0, runs: 3, totalTokens: 120,
    projects: [{ cwd: 'C:\\p', name: 'p', state: 'ok', running: 0, runs: 3, totalTokens: 120, trail: [] }]
  })[0].text
  assert.ok(!/[\u0370-\u03FF]/.test(txt), '输出不得含希腊字母：' + txt)
  assert.match(txt, /total 3 runs, 120 tokens/)
})

test('createLineStream: 非字符串 chunk 静默丢弃（v1.1.5 回归护栏）', () => {
  // 这条契约曾让 MCP 路径的活动明细全空：child.stdout 未声明编码时 'data' 派发
  // 的是 Buffer，pushChunk 收到非字符串直接 return，foldEvent 于是从不触发。
  // 行为本身是有意的（防御非法输入），但调用方必须自己保证喂字符串。
  let n = 0
  const s = createLineStream(() => { n++ })
  s.pushChunk(Buffer.from('{"type":"assistant"}\n'))
  assert.equal(n, 0, 'Buffer 被丢弃 —— 调用方必须先 setEncoding(utf8)')
  s.pushChunk('{"type":"assistant"}\n')
  assert.equal(n, 1, '字符串正常消费')
  // 半行安全：跨 chunk 的行必须拼接后才消费一次
  const seen = []
  const s2 = createLineStream((ln) => seen.push(ln))
  s2.pushChunk('{"a":')
  assert.deepEqual(seen, [], '半行不得提前消费')
  s2.pushChunk('1}\n')
  assert.deepEqual(seen, ['{"a":1}'])
})

test('MCP 源码契约：child.stdout 必须声明 utf8 编码', async () => {
  // 静默失败模式，值得用源码断言钉住：一旦有人删掉 setEncoding，活动明细会再次
  // 全空，而所有功能测试仍会通过（result 事件是从累积的 out 字符串解析的）。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../mcp/codebuddy-mcp-server.mjs', import.meta.url), 'utf8')
  assert.match(src, /child\.stdout\.setEncoding\('utf8'\)/, 'MCP 必须给 child.stdout 设 utf8 编码')
})

// ── v1.3.0：后端注册表 + 用户偏好路由 + 国际端点 env（v1.4.0 起四后端）─────

test('BACKENDS 注册表：四后端 + isBackend 白名单', () => {
  assert.deepEqual([...BACKENDS], ['codebuddy', 'codebuddy-intl', 'codebuddy-en', 'workbuddy'])
  assert.equal(DEFAULT_BACKEND, 'codebuddy')
  for (const b of BACKENDS) assert.equal(isBackend(b), true)
  assert.equal(isBackend('codebuddy-en'), true)
  assert.equal(isBackend('codebuddy-intl'), true)
  assert.equal(isBackend('bogus'), false)
  assert.equal(isBackend(undefined), false)
})

test('resolveBackend：显式 > 会话归属 > 用户偏好 > 默认', () => {
  // 显式 args.backend 最优先（合法值）
  assert.equal(resolveBackend({ backend: 'workbuddy' }, { backend: 'codebuddy' }, 'codebuddy-en'), 'workbuddy')
  // 非法显式值被忽略（而不是原样透传给 CLI）
  assert.equal(resolveBackend({ backend: 'bogus' }, { backend: 'workbuddy' }, null), 'workbuddy')
  // 会话归属次之
  assert.equal(resolveBackend({}, { backend: 'codebuddy-en' }, 'workbuddy'), 'codebuddy-en')
  assert.equal(resolveBackend({}, { backend: null }, 'workbuddy'), 'workbuddy')
  // 用户偏好再次之；全空 → 默认
  assert.equal(resolveBackend({}, { backend: null }, 'codebuddy-en'), 'codebuddy-en')
  assert.equal(resolveBackend({}, { backend: null }, 'bogus'), 'codebuddy')
  assert.equal(resolveBackend({}, {}, null), 'codebuddy')
})

// ── v1.3.3：WorkBuddy 国际版正名 + 后端别名 ──────────────────────────────────

test('normalizeBackend：workbuddy-en / workbuddy-ai 别名归一到 codebuddy-en；大小写不敏感', () => {
  assert.equal(normalizeBackend('workbuddy-en'), 'codebuddy-en')
  assert.equal(normalizeBackend('workbuddy-ai'), 'codebuddy-en')
  assert.equal(normalizeBackend('WorkBuddy-EN'), 'codebuddy-en')
  assert.equal(normalizeBackend('  codebuddy-en  '), 'codebuddy-en')
  assert.equal(normalizeBackend('CodeBuddy'), 'codebuddy')
  // 非后端名原样返回（由调用方 isBackend 兜底）；非字符串透传
  assert.equal(normalizeBackend('bogus'), 'bogus')
  assert.equal(normalizeBackend(undefined), undefined)
  assert.equal(normalizeBackend(null), null)
  // 别名表本身不与规范 id 冲突
  for (const b of BACKENDS) assert.equal(BACKEND_ALIASES[b], undefined)
})

test('resolveBackend 接受别名（三处优先级通道都归一）', () => {
  // 显式参数走别名
  assert.equal(resolveBackend({ backend: 'workbuddy-en' }, {}, null), 'codebuddy-en')
  // 会话归属走别名
  assert.equal(resolveBackend({}, { backend: 'workbuddy-ai' }, null), 'codebuddy-en')
  // 用户偏好走别名
  assert.equal(resolveBackend({}, {}, 'workbuddy-en'), 'codebuddy-en')
  // 别名 + 非法值混杂：非法仍被忽略
  assert.equal(resolveBackend({ backend: 'bogus' }, { backend: 'workbuddy-en' }, null), 'codebuddy-en')
})

test('BACKEND_LABELS 正名：国际面以 WorkBuddy 国际版（WorkBuddyAI）示人（v1.3.3）', () => {
  assert.match(BACKEND_LABELS['codebuddy-en'], /WorkBuddy 国际版/)
  assert.match(BACKEND_LABELS['codebuddy-en'], /WorkBuddyAI/)
  assert.ok(!/CodeBuddy 国际版/.test(BACKEND_LABELS['codebuddy-en']), '旧误导标签不得回潮')
})

// ── v1.4.0：CodeBuddy 国际版独立后端 + 运行时模型清单 ────────────────────────

test('v1.4.0：codebuddy-intl 是独立后端，别名 codebuddy-ioa / codebuddy-international', () => {
  assert.ok(BACKENDS.includes('codebuddy-intl'))
  assert.equal(normalizeBackend('codebuddy-ioa'), 'codebuddy-intl')
  assert.equal(normalizeBackend('codebuddy-international'), 'codebuddy-intl')
  assert.equal(normalizeBackend('CodeBuddy-Oversea'), 'codebuddy-intl')
  assert.equal(resolveBackend({ backend: 'codebuddy-ioa' }, {}, null), 'codebuddy-intl')
  assert.equal(resolveBackend({}, {}, 'codebuddy-international'), 'codebuddy-intl')
  assert.match(BACKEND_LABELS['codebuddy-intl'], /CodeBuddy 国际版/)
  // 与 WorkBuddy 国际版是两个不同选项（用户明确要求区分）
  assert.notEqual(BACKEND_LABELS['codebuddy-intl'], BACKEND_LABELS['codebuddy-en'])
  assert.ok(BACKEND_ENDPOINTS['codebuddy-intl'])
  assert.ok(BACKEND_AUTH_IDS['codebuddy-intl'])
})

test('extractModelIds：优先取更完整的那份（agents.cli vs 顶层 models）', () => {
  // WorkBuddyAI 的真实形态：agents.cli 只有 4 个角色别名，顶层 models 才是 37 个真实 id
  const wbAI = { agents: [{ name: 'cli', models: ['fast-model', 'balanced-model', 'primary-model', 'deep-model'] }], models: [{ id: 'default-model' }, { id: 'gpt-5.5' }, { id: 'gemini-3.1-pro' }, { id: 'kimi-k3' }, { id: 'hy3' }] }
  assert.deepEqual(extractModelIds(wbAI), ['default-model', 'gpt-5.5', 'gemini-3.1-pro', 'kimi-k3', 'hy3'])
  // npm CLI 形态：agents.cli(21) 比顶层(22) 少 → 取顶层
  const npmLike = { agents: [{ name: 'cli', models: ['a', 'b'] }], models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  assert.deepEqual(extractModelIds(npmLike), ['a', 'b', 'c'])
  // agents.cli 更多 → 取 agents.cli
  const cliHeavier = { agents: [{ name: 'cli', models: ['x', 'y', 'z'] }], models: [{ id: 'x' }] }
  assert.deepEqual(extractModelIds(cliHeavier), ['x', 'y', 'z'])
  // 字符串数组也接受，且去重
  assert.deepEqual(extractModelIds({ models: ['p', 'q', 'p'] }), ['p', 'q'])
  // 容错：空/坏输入 → null
  assert.equal(extractModelIds(null), null)
  assert.equal(extractModelIds('{ not json'), null)
  assert.equal(extractModelIds({}), null)
})

test('backendModelCatalog：v1.6.0 四后端一律以自己安装的描述文件为准，不做静态表并集', () => {
  // v1.6.0 推翻了 v1.4.1/v1.4.2 的「npm 面并集」设计：真机实测静态表既缺 CLI
  // 真实菜单里的型号（claude-opus-4.8 / gpt-5.4 / default），又会留住已下架的 id。
  // 而 product.${env}.json 是 CLI 运行时真正加载的那份，是唯一权威。
  const onlyHy3 = { readFileSync: () => JSON.stringify({ models: [{ id: 'hy3' }, { id: 'gpt-5.5' }] }) }
  for (const b of ['codebuddy', 'codebuddy-intl', 'codebuddy-en', 'workbuddy']) {
    assert.deepEqual(backendModelCatalog(b, onlyHy3), ['hy3', 'gpt-5.5'],
      b + '：文件为准，不并集静态表')
  }
  // 静态表只在读不到文件时兜底
  const noFile = { readFileSync: () => { throw new Error('ENOENT') } }
  assert.ok(backendModelCatalog('codebuddy', noFile).includes('hy4-preview'),
    '读不到文件时退化为静态表兜底')
})

test('backendModelCatalog：npm 面与桌面版都按各自描述文件解析（v1.6.0）', () => {
  const extra = { readFileSync: () => JSON.stringify({ models: [{ id: 'glm-5.2' }, { id: 'brand-new' }] }) }
  assert.deepEqual(backendModelCatalog('codebuddy', extra), ['glm-5.2', 'brand-new'],
    'npm 面不再把静态表排在前')
  assert.ok(!backendModelCatalog('codebuddy', extra).includes('hy4-preview'),
    '文件里没有的型号不再由静态表补进来')
})

test('parseCreditValue：只认 x<数字>，缺失/空串一律 null（0 与「未知」不可混淆）', () => {
  assert.equal(parseCreditValue('x0.29 credits'), 0.29)
  assert.equal(parseCreditValue('x0.00 credits'), 0, 'x0.00 必须解析为数字 0（= 免费）')
  assert.equal(parseCreditValue('x0.00'), 0, '省略 credits 后缀也要认')
  assert.equal(parseCreditValue('x3.31 credits'), 3.31, '倍率可大于 1')
  assert.equal(parseCreditValue('X0.5 credits'), 0.5, '大写 X 也认')
  assert.equal(parseCreditValue(''), null, '空串 → null（未知，不是免费）')
  assert.equal(parseCreditValue('  '), null)
  assert.equal(parseCreditValue(undefined), null)
  assert.equal(parseCreditValue('0.29'), null, '缺 x 前缀不认')
  assert.equal(parseCreditValue('x —'), null, '占位符不认')
})

test('extractModelCredits：从顶层 models 建 id→倍率 映射，无数据返回 null', () => {
  const doc = JSON.stringify({
    agents: [{ name: 'cli', models: ['hy3', 'glm-5.3'] }],
    models: [
      { id: 'hy3', credits: 'x0.00 credits' },
      { id: 'glm-5.3', credits: 'x0.79 credits' },
      { id: 'default-model', credits: '' }
    ]
  })
  const map = extractModelCredits(doc)
  assert.equal(map.get('hy3'), 0)
  assert.equal(map.get('glm-5.3'), 0.79)
  assert.ok(!map.has('default-model'), '空 credits 的条目不进映射')
  assert.equal(extractModelCredits('{"models":[]}'), null, '无有效倍率 → null')
  assert.equal(extractModelCredits('not json'), null, '坏 JSON → null')
  assert.equal(extractModelCredits({}), null)
})

test('formatCreditLabel：0 → 免费，其余两位小数，null → 空', () => {
  assert.equal(formatCreditLabel(0), '免费')
  assert.equal(formatCreditLabel(0.29), 'x0.29')
  assert.equal(formatCreditLabel(3.31), 'x3.31')
  assert.equal(formatCreditLabel(1.2), 'x1.20', '补零便于竖排对齐')
  assert.equal(formatCreditLabel(null), '')
  assert.equal(formatCreditLabel(undefined), '')
})

test('modelCatalogDetailed：挂倍率、免费优先在前、无数据殿后（v1.5.0）', () => {
  const doc = JSON.stringify({
    models: [
      { id: 'hy3', credits: 'x0.00 credits' },
      { id: 'glm-5.3', credits: 'x0.79 credits' },
      { id: 'cheap', credits: 'x0.06 credits' },
      { id: 'no-credit', credits: '' }
    ]
  })
  const io = { readFileSync: () => doc }
  const items = modelCatalogDetailed('codebuddy', io)
  const byId = Object.fromEntries(items.map((x) => [x.id, x]))
  assert.equal(byId['hy3'].free, true)
  assert.equal(byId['hy3'].label, 'hy3 · 免费')
  assert.equal(byId['glm-5.3'].label, 'glm-5.3 · x0.79')
  assert.equal(byId['glm-5.3'].free, false)
  assert.equal(byId['no-credit'].hasCredits, false)
  assert.equal(byId['no-credit'].label, 'no-credit', '无倍率时不挂后缀')
  // 免费/低价在前
  assert.equal(items[0].credits, 0, '免费排最前')
  const pricedIdx = items.map((x, i) => [x, i]).filter(([x]) => x.hasCredits)
  for (let i = 1; i < pricedIdx.length; i++) {
    assert.ok(pricedIdx[i - 1][0].credits <= pricedIdx[i][0].credits, '有倍率的按升序')
  }
  // 无数据殿后
  const firstNoCredit = items.findIndex((x) => !x.hasCredits)
  if (firstNoCredit >= 0) {
    assert.ok(items.slice(firstNoCredit).every((x) => !x.hasCredits), '无数据的全部殿后')
  }
})

test('modelCatalogDetailed：倍率随 CLI 描述文件实时同步（改文件即变，无需改插件）', () => {
  const v1 = { readFileSync: () => JSON.stringify({ models: [{ id: 'hy3', credits: 'x0.00 credits' }] }) }
  const v2 = { readFileSync: () => JSON.stringify({ models: [{ id: 'hy3', credits: 'x0.12 credits' }] }) }
  assert.equal(modelCatalogDetailed('codebuddy', v1).find((x) => x.id === 'hy3').label, 'hy3 · 免费')
  assert.equal(modelCatalogDetailed('codebuddy', v2).find((x) => x.id === 'hy3').label, 'hy3 · x0.12',
    'CLI 升级改了 credits 后，标签应直接跟着变')
})

test('backendSettingsMeta 带 modelOptions（含 label），models 仍为纯 id 数组', () => {
  const doc = JSON.stringify({
    models: [{ id: 'hy3', credits: 'x0.00 credits' }, { id: 'glm-5.3', credits: 'x0.79 credits' }]
  })
  const io = { readFileSync: () => doc }
  const meta = backendSettingsMeta('codebuddy', io)
  assert.ok(Array.isArray(meta.modelOptions) && meta.modelOptions.length, '应有 modelOptions')
  const hy3 = meta.modelOptions.find((x) => x.id === 'hy3')
  assert.equal(hy3.label, 'hy3 · 免费')
  assert.equal(hy3.credits, 0)
  assert.equal(hy3.free, true)
  // v1.6.0 回归：authorized 必须透传到 modelOptions，否则面板的「可用/未授权」
  // 分流会全部落空（曾因漏传导致面板一个模型都渲染不出来）。
  assert.ok('authorized' in hy3, 'modelOptions 必须带 authorized 字段')
  assert.equal(hy3.authorized, null, '未探测时是 null（而不是 false）')
  const io2 = { readFileSync: () => doc, accountModels: ['hy3'] }
  const meta2 = backendSettingsMeta('codebuddy', io2)
  assert.equal(meta2.modelOptions.find((x) => x.id === 'hy3').authorized, true)
  assert.equal(meta2.modelOptions.find((x) => x.id === 'glm-5.3').authorized, false,
    '不在账号清单里的型号标未授权')
  assert.ok(meta.models.every((m) => typeof m === 'string'), 'models 保持纯字符串数组（向后兼容）')
  assert.deepEqual(meta.models, meta.modelOptions.map((x) => x.id))
})

test('formatModelCatalogText：输出 id · 倍率 的紧凑文本', () => {
  const doc = JSON.stringify({ models: [{ id: 'hy3', credits: 'x0.00 credits' }, { id: 'glm-5.3', credits: 'x0.79 credits' }] })
  const t = formatModelCatalogText('codebuddy', { readFileSync: () => doc })
  assert.ok(t.includes('hy3 · 免费'), t)
  assert.ok(t.includes('glm-5.3 · x0.79'), t)
})

test('lookupModelCredits：跨 -ioa 命名与别名表匹配（v1.6.0）', () => {
  const map = new Map([['glm-5.3-ioa', 0.79], ['kimi-k3', 1.62], ['hy3', 0], ['codewise-default-model-v2', 2.0]])
  // 账号清单用无后缀名，描述文件用 -ioa 名 —— 必须匹配上
  assert.equal(lookupModelCredits(map, 'glm-5.3'), 0.79, '自动补 -ioa 后缀')
  assert.equal(lookupModelCredits(map, 'glm-5.3-ioa'), 0.79, '精确同名')
  assert.equal(lookupModelCredits(map, 'kimi-k3-1'), 1.62, '别名表：kimi-k3-1 → kimi-k3')
  assert.equal(lookupModelCredits(map, 'hy3-x'), 0, '别名表：hy3-x → hy3（免费）')
  assert.equal(lookupModelCredits(map, 'default'), 2.0, '别名表：default → codewise-default-model-v2')
  assert.equal(lookupModelCredits(map, 'unknown-model'), null)
  assert.equal(lookupModelCredits(null, 'hy3'), null, '无映射表 → null 而不是抛错')
})

test('modelCatalogDetailed：账号清单在前、未授权标记、倍率跨命名挂上（v1.6.0）', () => {
  const doc = JSON.stringify({
    models: [
      { id: 'glm-5.3-ioa', credits: 'x0.79 credits' },
      { id: 'hy3-ioa', credits: 'x0.00 credits' },
      { id: 'claude-opus-4.8', credits: 'x3.33 credits' }
    ]
  })
  const io = { readFileSync: () => doc, accountModels: ['hy3', 'glm-5.3'] }
  const items = modelCatalogDetailed('codebuddy', io)
  const byId = Object.fromEntries(items.map((x) => [x.id, x]))
  // 账号清单里的两条：已授权 + 倍率跨命名挂上
  assert.equal(byId['hy3'].authorized, true)
  assert.equal(byId['hy3'].credits, 0)
  assert.equal(byId['hy3'].label, 'hy3 · 免费')
  assert.equal(byId['glm-5.3'].authorized, true)
  assert.equal(byId['glm-5.3'].credits, 0.79)
  assert.equal(byId['glm-5.3'].label, 'glm-5.3 · x0.79')
  // 描述文件独有：标未授权
  assert.equal(byId['claude-opus-4.8'].authorized, false)
  assert.ok(byId['claude-opus-4.8'].label.includes('未授权'), '未授权要写在 label 里')
  // 已授权的排在未授权之前
  const firstBlocked = items.findIndex((x) => x.authorized === false)
  const lastAuthorized = items.map((x) => x.authorized).lastIndexOf(true)
  assert.ok(lastAuthorized < firstBlocked, '已授权全部排在未授权之前')
})

test('rememberAccountCatalog / getAccountCatalog：缓存服务端实时清单', () => {
  const backend = 'workbuddy'
  assert.equal(getAccountCatalog(backend), null, '未记录前为 null')
  rememberAccountCatalog(backend, ['auto', 'hy3'])
  assert.deepEqual(getAccountCatalog(backend), ['auto', 'hy3'])
  // 空数组不覆盖已有缓存（避免一次解析失败抹掉好数据）
  rememberAccountCatalog(backend, [])
  assert.deepEqual(getAccountCatalog(backend), ['auto', 'hy3'])
  // 返回副本，外部改动不影响内部
  const got = getAccountCatalog(backend)
  got.push('injected')
  assert.deepEqual(getAccountCatalog(backend), ['auto', 'hy3'])
})

test('免费模型归属：hy3 / deepseek-v4.1-flash 属 npm 面，不在 WorkBuddyAI 目录', () => {
  // 真机读 product.json 的 credits 字段：这两件是 x0.00（免费）
  assert.ok(BACKEND_MODEL_IDS['codebuddy'].includes('hy3'), 'npm 面含免费 hy3')
  assert.ok(BACKEND_MODEL_IDS['codebuddy'].includes('deepseek-v4.1-flash'), 'npm 面含免费 deepseek-v4.1-flash')
  assert.ok(BACKEND_MODEL_IDS['codebuddy'].includes('hy4-preview'), 'npm 面含 hy4-preview')
  // WorkBuddyAI 只有 hy3（实测其 product.json 无 hy4-preview / deepseek-v4.1-flash）
  assert.ok(BACKEND_MODEL_IDS['codebuddy-en'].includes('hy3'), 'WorkBuddyAI 含 hy3')
  assert.ok(!BACKEND_MODEL_IDS['codebuddy-en'].includes('hy4-preview'), 'WorkBuddyAI 不得含 hy4-preview')
  assert.ok(!BACKEND_MODEL_IDS['codebuddy-en'].includes('deepseek-v4.1-flash'), 'WorkBuddyAI 不得含 deepseek-v4.1-flash')
  // 免费优先：回退表首项应是 hy3
  assert.equal(BACKEND_MODEL_IDS['codebuddy-en'][0], 'hy3', '免费模型排最前')
})

test('backendModelCatalog：文件为准；读不到文件才回退静态表（v1.6.0 取代 v1.4.1 的并集）', () => {
  // 文件命中的情况下，静态表**完全不参与**（这是 v1.6.0 的核心行为变更）
  const fake = { readFileSync: () => JSON.stringify({ models: [{ id: 'glm-5.2' }, { id: 'brand-new-from-file' }] }) }
  const ids = backendModelCatalog('codebuddy', fake)
  assert.deepEqual(ids, ['glm-5.2', 'brand-new-from-file'], '文件里是什么就是什么')
  assert.ok(!ids.includes('hy4-preview'), '文件里没有的型号不再由静态表补进来')
  // 读不到文件 → 回退纯静态表，非空
  const boom = { readFileSync: () => { throw new Error('nope') } }
  const fb = backendModelCatalog('codebuddy', boom)
  assert.deepEqual(fb, BACKEND_MODEL_IDS['codebuddy'])
  // npm 面静态表仍需含账号实测型号（兜底质量）
  assert.ok(fb.includes('hy4-preview'))
  // 未知后端 → 空数组而不是抛错
  assert.deepEqual(backendModelCatalog('bogus', boom), [])
  // 旧名仍可用（v1.4.0 引入时的函数名）
  assert.deepEqual(readBackendModelCatalog('codebuddy', boom), fb)
})

test('parseAccountModels：解析服务端「该账号当前支持的模型」清单（权威来源）', () => {
  const real = [
    '400 model [__probe__] service info not found (01a0d498/01a0d498)',
    'Currently supported models for your account:',
    '  - hy4-preview',
    '  - hy3',
    '  - glm-5.3',
    '',
    'Please use --model <model_id> to specify a valid model.'
  ].join('\n')
  assert.deepEqual(parseAccountModels(real), ['hy4-preview', 'hy3', 'glm-5.3'])
  // 去重
  assert.deepEqual(parseAccountModels('Currently supported models for your account:\n- a\n- a\n- b\n'), ['a', 'b'])
  // 无该段 → null（例如 Authentication required 的报错）
  assert.equal(parseAccountModels('Authentication required. Please use /login command to sign in'), null)
  assert.equal(parseAccountModels(''), null)
  assert.equal(parseAccountModels(null), null)
})

test('静态模型表：不含该账号实测不存在的发行版候选 id（v1.4.0 的错）', () => {
  // 这些是 product.json 的发行版候选，真机实测均报 service info not found
  const bogus = ['default-model', 'primary-model', 'gpt-6-astra', 'gpt-5.6-sol']
  for (const b of ['codebuddy', 'workbuddy']) {
    for (const x of bogus) {
      assert.ok(!BACKEND_MODEL_IDS[b].includes(x), `${b} 不应含不存在的 ${x}`)
    }
  }
  // codebuddy 与 workbuddy 共享同一账号清单，workbuddy 多一个 auto
  assert.ok(BACKEND_MODEL_IDS['workbuddy'].includes('auto'))
  assert.ok(BACKEND_MODEL_IDS['codebuddy'].includes('hy4-preview'))
  assert.ok(BACKEND_MODEL_IDS['workbuddy'].includes('hy4-preview'))
})

test('codebuddy-intl 诊断：账号未授权时给出可操作提示（真机 400 文案）', () => {
  const h = endpointMismatchHint('codebuddy-intl', 'www.codebuddy.cn', false)
  assert.match(h, /codebuddy-intl/)
  assert.match(h, /authorized users|授权/)
})

test('resolveEndpoint：显式覆盖优先；否则按登录域推导；未知域返回 null', () => {
  // 显式覆盖最高优先（即使登录域已知）
  assert.equal(resolveEndpoint('https://custom/v2', 'www.codebuddy.cn'), 'https://custom/v2')
  // 登录域推导（实测可用端点）
  assert.equal(resolveEndpoint('', 'www.codebuddy.cn'), 'https://www.codebuddy.cn/v2')
  assert.equal(resolveEndpoint(null, 'copilot.tencent.com'), 'https://copilot.tencent.com/v2')
  assert.equal(resolveEndpoint('', 'www.workbuddy.ai'), 'https://www.workbuddy.ai/v2')
  // 未知/缺失登录域 → null（沿用 CLI 自身 product 端点）
  assert.equal(resolveEndpoint('', ''), null)
  assert.equal(resolveEndpoint(null, null), null)
  assert.equal(resolveEndpoint('', 'example.com'), null)
})

test('endpointEnv：仅当端点与 product 端点不同才注入 BASE_URL；不再注入 INTERNET_ENVIROMENT', () => {
  // 默认后端 codebuddy：product 端点是 www.codebuddy.ai，登录域是 www.codebuddy.cn
  // → 必须注入覆盖，否则 401（这是功能修复，不是优化）。
  const env = endpointEnv('codebuddy', null, 'www.codebuddy.cn', null)
  assert.equal(env.CODEBUDDY_BASE_URL, 'https://www.codebuddy.cn/v2')
  // 域与 product 端点一致时无需注入
  assert.equal(endpointEnv('codebuddy', null, 'www.codebuddy.ai', null), null)
  // 已删除的错误行为：无条件 cloudhosted 声明（www.workbuddy.ai 属 externalDomain）
  assert.equal(env.CODEBUDDY_INTERNET_ENVIROMENT, undefined)
  // workbuddy：登录域与 product 端点一致 → 不注入
  assert.equal(endpointEnv('workbuddy', null, 'copilot.tencent.com', null), null)
  // 显式覆盖始终生效
  assert.equal(endpointEnv('codebuddy-en', 'https://x/v2', 'www.workbuddy.ai', null).CODEBUDDY_BASE_URL, 'https://x/v2')
})

test('endpointEnv：codebuddy-en 的 token 经 CODEBUDDY_AUTH_TOKEN 下发；其他后端不下发', () => {
  const env = endpointEnv('codebuddy-en', null, 'www.workbuddy.ai', 'tok-123')
  assert.equal(env.CODEBUDDY_AUTH_TOKEN, 'tok-123')
  // token 不影响端点（端点由登录域决定）
  assert.equal(env.CODEBUDDY_BASE_URL, undefined)
  // 空 token 不注入
  assert.equal(endpointEnv('codebuddy-en', null, 'www.workbuddy.ai', '   '), null)
  // 其他后端即使给了 token 也不下发（各产品面凭据互斥）；但端点仍按登录域对齐。
  const other = endpointEnv('codebuddy', null, 'www.codebuddy.cn', 'tok')
  assert.equal(other.CODEBUDDY_AUTH_TOKEN, undefined)
  assert.equal(other.CODEBUDDY_BASE_URL, 'https://www.codebuddy.cn/v2')
})

test('endpointMismatchHint：codebuddy-en 缺 token 给出可操作指引；域一致时无提示', () => {
  const hint = endpointMismatchHint('codebuddy-en', 'www.workbuddy.ai', false)
  assert.match(hint, /codebuddyEnToken/)
  assert.match(hint, /workbuddy/)
  // 有 token 且域与 product 端点一致 → 无提示
  assert.equal(endpointMismatchHint('codebuddy-en', 'www.workbuddy.ai', true), null)
  // 域不匹配 → 提示已自动注入端点
  assert.match(endpointMismatchHint('codebuddy', 'www.codebuddy.cn', false), /CODEBUDDY_BASE_URL/)
  assert.equal(endpointMismatchHint('codebuddy', 'www.codebuddy.ai', false), null)
})

test('isLimited/failureHint：AUTH_REQUIRED 不算限流，且透传可操作指引', () => {
  const res = { ok: false, status: 'AUTH_REQUIRED', stderr: 'token 缺失：请填 codebuddyEnToken' }
  assert.equal(isLimited(res), false)
  assert.match(failureHint(res), /codebuddyEnToken/)
})

// ── codebuddy-en 凭据三通道（v1.3.1）────────────────────────────────────────
// 国际版 token 被 protector key 封装、密钥不落盘；但用户往往已在 DSH 里配好
// 指向 workbuddy.ai/v2 的 token（.credentials.yaml 的 WORKBUDDY_TOKEN）——
// 真机实测该 token 下发给 WorkBuddyAI CLI 可返回 PONG，故自动复用能让
// codebuddy-en 开箱即用。优先级：设置面板 > 环境变量 > DSH 凭据库。

test('resolveEnToken：优先级 设置面板 > 环境变量 > DSH 凭据库', async () => {
  const os = await import('node:os')
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'cb-cred-'))
  const realDir = process.env.CODEBUDDY_CREDENTIALS_DIR
  const realEnv = process.env.CODEBUDDY_AUTH_TOKEN
  try {
    // 1) 设置面板优先
    assert.deepEqual(resolveEnToken('from-setting'), { token: 'from-setting', source: 'setting' })

    // 2) 环境变量次之
    process.env.CODEBUDDY_AUTH_TOKEN = 'from-env'
    assert.deepEqual(resolveEnToken(''), { token: 'from-env', source: 'env' })
    delete process.env.CODEBUDDY_AUTH_TOKEN

    // 3) DSH 凭据库兜底（.credentials.yaml）
    const tok = 'e'.repeat(120)
    fsMod.writeFileSync(pathMod.join(dir, '.credentials.yaml'),
      'version: 1\nrefs:\n  WORKBUDDY_TOKEN: ' + tok + '\n', 'utf8')
    process.env.CODEBUDDY_CREDENTIALS_DIR = dir
    assert.deepEqual(resolveEnToken(''), { token: tok, source: 'dsh-store' })

    // 4) 三通道皆空 → null（走「让用户填」的提示路径）
    fsMod.writeFileSync(pathMod.join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n', 'utf8')
    assert.deepEqual(resolveEnToken(''), { token: null, source: null })
  } finally {
    if (realDir === undefined) delete process.env.CODEBUDDY_CREDENTIALS_DIR; else process.env.CODEBUDDY_CREDENTIALS_DIR = realDir
    if (realEnv === undefined) delete process.env.CODEBUDDY_AUTH_TOKEN; else process.env.CODEBUDDY_AUTH_TOKEN = realEnv
    fsMod.rmSync(dir, { recursive: true, force: true })
  }
})

test('readDshWorkbuddyToken：只接受真实 token，跳过 $VAR 引用/占位符/过短值', async () => {
  const os = await import('node:os')
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'cb-cred2-'))
  const realDir = process.env.CODEBUDDY_CREDENTIALS_DIR
  try {
    process.env.CODEBUDDY_CREDENTIALS_DIR = dir
    const f = pathMod.join(dir, '.credentials.yaml')
    // $VAR 引用不应被当作凭据
    fsMod.writeFileSync(f, '  WORKBUDDY_TOKEN: $SOME_VAR\n', 'utf8')
    assert.equal(readDshWorkbuddyToken(), null)
    // 占位符不应被当作凭据
    fsMod.writeFileSync(f, '  WORKBUDDY_TOKEN: <your-token-here>\n', 'utf8')
    assert.equal(readDshWorkbuddyToken(), null)
    // 过短值不应被当作凭据
    fsMod.writeFileSync(f, '  WORKBUDDY_TOKEN: short\n', 'utf8')
    assert.equal(readDshWorkbuddyToken(), null)
    // 真实 JWT 形态（带引号）应被取出并去引号
    const jwt = 'eyJhbGciOi.' + 'x'.repeat(100) + '.sig'
    fsMod.writeFileSync(f, '  WORKBUDDY_TOKEN: "' + jwt + '"\n', 'utf8')
    assert.equal(readDshWorkbuddyToken(), jwt)
    // .env 形态（KEY=value）
    fsMod.writeFileSync(f, 'refs:\n', 'utf8')
    fsMod.writeFileSync(pathMod.join(dir, '.env'), 'WORKBUDDY_TOKEN=' + jwt + '\n', 'utf8')
    assert.equal(readDshWorkbuddyToken(), jwt)
  } finally {
    if (realDir === undefined) delete process.env.CODEBUDDY_CREDENTIALS_DIR; else process.env.CODEBUDDY_CREDENTIALS_DIR = realDir
    fsMod.rmSync(dir, { recursive: true, force: true })
  }
})

test('endpointMismatchHint：缺凭据时的指引列出三条通道', () => {
  const hint = endpointMismatchHint('codebuddy-en', 'www.workbuddy.ai', false)
  assert.match(hint, /codebuddyEnToken/)
  assert.match(hint, /CODEBUDDY_AUTH_TOKEN/)
  assert.match(hint, /WORKBUDDY_TOKEN/)
})

test('buildArgv：defaultModel 只在未显式指定 model 时注入 + env 透传', () => {
  const built = buildArgv(['node', 'cb'], { prompt: 'x' }, { defaultModel: 'glm-5.2', env: { A: '1' } })
  assert.ok(built.argv.includes('--model') && built.argv.includes('glm-5.2'))
  assert.deepEqual(built.env, { A: '1' })
  const built2 = buildArgv(['node', 'cb'], { prompt: 'x', model: 'hy3' }, { defaultModel: 'glm-5.2', env: { A: '1' } })
  assert.ok(built2.argv.includes('hy3') && !built2.argv.includes('glm-5.2'))
  // 无 defaultModel / 无 env：不注入、env=null
  const built3 = buildArgv(['node', 'cb'], { prompt: 'x' }, {})
  assert.ok(!built3.argv.includes('--model'))
  assert.equal(built3.env, null)
})

test('isLimited：401 认证失败/端点域不匹配不算限流（v1.3.0 真机实测）', () => {
  // 真机 401 文案（codebuddy-en + 国内 token）：含 401/认证/端点字样，
  // 若归入限流会误弹「回退/重试」三选一 —— 但重试与回退都无效。
  const en401 = {
    ok: false, status: 'FAILED',
    stderr: '401 Authentication failed (401) for model "auto". The request was sent to https://www.workbuddy.ai, which differs from the current product endpoint https://www.codebuddy.ai. (token-length:1322)'
  }
  assert.equal(isLimited(en401), false, '401 认证失败不得判为限流')
  // failureHint 给出可行动指引
  const hint = failureHint(en401)
  assert.ok(hint.includes('401') && hint.includes('登录'), '应提示重新登录: ' + hint)
  // 回归：真限流/网络类仍判限流
  assert.equal(isLimited({ ok: false, status: 'FAILED', stderr: 'rate limit exceeded' }), true)
  assert.equal(isLimited({ ok: false, status: 'FAILED', stderr: 'connect ECONNREFUSED x:443' }), true)
  // 瞬时 CLI 错误路径不受影响（401 不是 error_during_execution，也不该被重试）
  assert.equal(isTransientCliError(en401), false)
})


// ── v1.6.1：账号级配置 + 促销（modelPromotions）───────────────────────────────
//
// 背景：用户第三次反馈「模型获取错误」，并给出 CLI 真实菜单。根因是此前的数据源
// 层次不对 —— 安装目录的 product.json 只是**产品面默认值**，而用户菜单来自
// **账号级配置**，只有后者带 modelPromotions（「Free now / 夜间免费 / 限时免费」）。
// 实测对照（用户贴图逐条吻合）：
//   国内版 hy4-preview 夜间免费 0.29x → 基础 x0.29 + promotion「夜间免费」
//   国内版 hy3        限时免费 0.00x → 基础 x0.00 + promotion「限时免费」
//   国际版 三个都是 Free now 0.00x   → 3 条 promotion「Free now」factor=0

test('normalizeProductConfig：单对象与 [{userId,data}] 数组两种形态都要认', () => {
  // 形态一：裸 product 对象（cache/acc-product-config-v3.json）
  const single = normalizeProductConfig(JSON.stringify({ applicationName: 'WorkBuddy', models: [{ id: 'hy3' }] }))
  assert.equal(single.applicationName, 'WorkBuddy')
  assert.equal(single.models.length, 1)

  // 形态二：local_storage/entry_*.info 的顶层数组，末尾条目最新 → 取最后一份
  const arr = normalizeProductConfig(JSON.stringify([
    { userId: 'old', data: { applicationName: 'OLD', models: [] } },
    { userId: 'new', data: { applicationName: 'NEW', models: [{ id: 'hy4-preview' }] } }
  ]))
  assert.equal(arr.applicationName, 'NEW', '数组形态必须取最后一份（最新写入在末尾）')
  assert.equal(arr.models[0].id, 'hy4-preview')

  // 异常输入一律 null，不抛
  assert.equal(normalizeProductConfig('not json'), null)
  assert.equal(normalizeProductConfig(null), null)
  assert.equal(normalizeProductConfig('[]'), null)
})

test('extractModelPromotions：解析 modelPromotions 并展开到每个 modelIds', () => {
  const cfg = JSON.stringify({
    modelPromotions: [
      {
        badge: { color: '#FF0000', label: 'Free now' },
        discount: { discountedCredits: '0x', factor: 0, displayMode: 'replace' },
        enabled: true,
        modelIds: ['hy3', 'deepseek-v4.1-flash'],
        priority: 200,
        schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' }
      },
      // enabled:false 必须被忽略
      { badge: { label: '已停用' }, modelIds: ['zzz'], enabled: false },
      // 无 badge.label 或 modelIds 为空 → 跳过
      { badge: {}, modelIds: ['yyy'], enabled: true },
      { badge: { label: 'x' }, modelIds: [], enabled: true }
    ]
  })
  const ps = extractModelPromotions(cfg)
  assert.equal(ps.length, 2, '两个 modelIds 展开成两条，其余三种情况全部跳过')
  assert.deepEqual(ps.map((p) => p.id).sort(), ['deepseek-v4.1-flash', 'hy3'])
  assert.equal(ps[0].label, 'Free now')
  assert.equal(ps[0].factor, 0)
  assert.equal(ps[0].priority, 200)

  // 无 modelPromotions 字段 → null（安装目录 product.json 就是这种）
  assert.equal(extractModelPromotions(JSON.stringify({ models: [] })), null)
})

test('isPromotionActive：有效期 + 跨零点时段都要判对', () => {
  // 「夜间免费」：每天 23:00–次日 8:00，跨零点
  const night = {
    label: '夜间免费',
    schedule: {
      daily: [{ start: '23:00', end: '8:00' }],
      timezone: 'Asia/Shanghai',
      validFrom: '2026-09-11T00:00:00+08:00',
      validUntil: '2026-11-01T00:00:00+08:00'
    }
  }
  const at = (h, m) => { const d = new Date('2026-09-20T00:00:00'); d.setHours(h, m, 0, 0); return d }
  assert.equal(isPromotionActive(night, at(2, 0)), true, '凌晨 2:00 落在跨零点区间内')
  assert.equal(isPromotionActive(night, at(23, 30)), true, '23:30 落在区间起点之后')
  assert.equal(isPromotionActive(night, at(14, 0)), false, '白天 14:00 不在区间内')
  assert.equal(isPromotionActive(night, at(8, 0)), false, 'end 为开区间，8:00 整点不算')
  assert.equal(isPromotionActive(night, at(22, 59)), false, '22:59 尚未开始')

  // 有效期外
  const expired = { ...night, schedule: { ...night.schedule, validUntil: '2026-09-15T00:00:00+08:00' } }
  assert.equal(isPromotionActive(expired, at(2, 0)), false, 'validUntil 之后失效')
  const future = { ...night, schedule: { ...night.schedule, validFrom: '2026-10-01T00:00:00+08:00' } }
  assert.equal(isPromotionActive(future, at(2, 0)), false, 'validFrom 之前不生效')

  // 无 schedule.daily → 全天有效（「限时免费」就是这种）
  const allDay = { label: '限时免费', schedule: { validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' } }
  assert.equal(isPromotionActive(allDay, at(14, 0)), true)
  // 完全无 schedule → 视为始终生效
  assert.equal(isPromotionActive({ label: 'x' }, at(14, 0)), true)
})

test('activePromotionFor：同一型号多条命中时取 priority 最大者', () => {
  // 实测国内版 hy4-preview 有两条：白天一条（只挂角标、无 discount），
  // 夜间一条（factor=0 真正免费）。priority 相同时保持先命中者。
  const at = (h) => { const d = new Date('2026-09-20T00:00:00'); d.setHours(h, 0, 0, 0); return d }
  const promos = [
    { id: 'hy4-preview', label: '夜间免费', priority: 50, factor: null,
      schedule: { daily: [{ start: '8:00', end: '23:00' }] } },
    { id: 'hy4-preview', label: '夜间免费', priority: 50, factor: 0,
      schedule: { daily: [{ start: '23:00', end: '8:00' }] } }
  ]
  assert.equal(activePromotionFor(promos, 'hy4-preview', at(14)).factor, null, '白天命中的是不带折扣的那条')
  assert.equal(activePromotionFor(promos, 'hy4-preview', at(2)).factor, 0, '夜间命中的是 factor=0 那条')
  assert.equal(activePromotionFor(promos, 'other', at(2)), null, '无关型号返回 null')
  assert.equal(activePromotionFor(null, 'hy4-preview', at(2)), null, '无促销数据不抛错')
})

test('parseCreditValue：兼容 "x0.29" 与促销价的 "0.00x" 两种写法', () => {
  // 前者来自 models[].credits，后者来自 modelPromotions[].discount.discountedCredits。
  // v1.6.0 只认前者，导致「Free now」这类促销价的数值被读成 null。
  assert.equal(parseCreditValue('x0.29 credits'), 0.29)
  assert.equal(parseCreditValue('x0.00'), 0)
  assert.equal(parseCreditValue('0.00x'), 0, '促销写法：数字在前')
  assert.equal(parseCreditValue('0x'), 0, '促销写法：0x 即免费')
  assert.equal(parseCreditValue('0.50x'), 0.5, '五折')
  assert.equal(parseCreditValue(''), null)
  assert.equal(parseCreditValue('abc'), null)
})

test('modelCatalogDetailed：促销命中时以促销价计入，标签挂促销名', () => {
  // 构造一个「账号配置」文件，验证三层数据源合并后的最终标签
  const accountCfg = JSON.stringify({
    applicationName: 'WorkBuddy',
    agents: [{ name: 'cli', models: ['hy3', 'hy4-preview', 'glm-5.2'] }],
    models: [
      { id: 'hy3', credits: 'x0.00' },
      { id: 'hy4-preview', credits: 'x0.29' },
      { id: 'glm-5.2', credits: 'x0.79' }
    ],
    modelPromotions: [
      { badge: { label: '限时免费' }, discount: { discountedCredits: '0x', factor: 0 }, enabled: true,
        modelIds: ['hy3'], priority: 200 },
      { badge: { label: '夜间免费' }, discount: { discountedCredits: '0.00x', factor: 0 }, enabled: true,
        modelIds: ['hy4-preview'], priority: 50,
        schedule: { daily: [{ start: '23:00', end: '8:00' }] } }
    ]
  })
  const io = {
    readFileSync: (p) => { if (String(p).includes('acc-product-config')) return accountCfg; throw new Error('ENOENT') },
    // 显式注入账号清单，避免依赖模块级 ACCOUNT_CATALOG_CACHE（其他用例会写入它）
    accountModels: ['hy3', 'hy4-preview', 'glm-5.2'],
    // 夜间 2:00：hy4-preview 的「夜间免费」应生效
    now: (() => { const d = new Date('2026-09-20T00:00:00'); d.setHours(2, 0, 0, 0); return d })()
  }
  const items = modelCatalogDetailed('workbuddy', io)
  const by = (id) => items.find((x) => x.id === id)

  // hy3：基础免费 + 限时免费促销 → 免费，且挂促销名
  assert.equal(by('hy3').label, 'hy3 · 免费 · 限时免费')
  assert.equal(by('hy3').promotion.label, '限时免费')

  // hy4-preview：夜间命中 factor=0 → 实付 0.29*0 = 0，原价仍保留在 baseCredits
  assert.equal(by('hy4-preview').label, 'hy4-preview · 免费 · 夜间免费')
  assert.equal(by('hy4-preview').baseCredits, 0.29, '原价必须保留，便于用户判断促销力度')
  assert.equal(by('hy4-preview').credits, 0)

  // glm-5.2：无促销命中 → 只挂倍率
  assert.equal(by('glm-5.2').label, 'glm-5.2 · x0.79')
  assert.equal(by('glm-5.2').promotion, null)
})

test('modelCatalogDetailed：带促销的文件优先于更新的旧缓存（国际版真实场景）', () => {
  // 实测国际版：cache/acc-product-config-v3.json 停在旧时间点（37 项、无促销、
  // 且没有 hy4-preview / deepseek-v4.1-flash），而 local_storage 快照才带三条
  // Free now 促销。候选链里 cache 在前，若不特判就会遮蔽真实菜单。
  const staleCache = JSON.stringify({
    applicationName: 'workbuddy-ai',
    models: [{ id: 'hy3', credits: 'x0.00' }, { id: 'old-only', credits: 'x0.10' }]
  })
  const liveSnap = JSON.stringify([{
    userId: 'dc632238',
    data: {
      applicationName: 'workbuddy-ai',
      agents: [{ name: 'cli', models: ['hy3', 'hy4-preview-f', 'deepseek-v4.1-flash'] }],
      models: [
        { id: 'hy3', credits: 'x0.00' },
        { id: 'hy4-preview-f', credits: 'x0.00' },
        { id: 'deepseek-v4.1-flash', credits: 'x0.00' }
      ],
      modelPromotions: [
        { badge: { label: 'Free now' }, discount: { discountedCredits: '0x', factor: 0 }, enabled: true,
          modelIds: ['hy3', 'hy4-preview-f', 'deepseek-v4.1-flash'], priority: 200 }
      ]
    }
  }])
  const io = {
    readFileSync: (p) => {
      const s = String(p)
      if (s.includes('acc-product-config')) return staleCache
      if (s.includes('local_storage')) return liveSnap
      throw new Error('ENOENT')
    }
  }
  const items = modelCatalogDetailed('codebuddy-en', io)
  assert.ok(items.some((x) => x.id === 'hy4-preview-f'), '必须采用带促销的那份，hy4-preview-f 要在列')
  assert.ok(!items.some((x) => x.id === 'old-only'), '旧缓存的独有型号不应出现')
  for (const id of ['hy3', 'hy4-preview-f', 'deepseek-v4.1-flash']) {
    const x = items.find((i) => i.id === id)
    assert.equal(x.label, id + ' · 免费 · Free now', id + ' 应为免费并挂 Free now')
  }
})
