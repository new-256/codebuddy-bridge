// test/core.test.mjs — 共享核心的纯函数 + 状态引擎 + 行流单测。
// 覆盖关键回归位：非 SUCCESS 失败后全局状态不抛错、半行拼接、
// LIMIT_RE 词边界与匹配面收窄、summarizeArgs 无损 JSON、按项目用量累计、
// 会话感知 cwd 回落、MRU 淘汰。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isLimited, clampInt, shortLabel, summarizeArgs, parseCodebuddyJson, buildResult,
  buildArgv, fallbackResult, createLineStream, createStatusEngine, renderResult, renderStatus
} from '../core/codebuddy-core.mjs'

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
  assert.ok(st[0].text.includes('Σ 2 runs · 15 tokens'))
})
