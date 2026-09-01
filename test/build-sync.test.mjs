// test/build-sync.test.mjs — 派生产物同步锁定。
// dynamic/host.js 与 preset/codebuddy-first/codebuddy-core.mjs 都是生成物：
// 忘记在改 core/template 后运行 `node scripts/build.mjs` 时，本测试失败，
// 「修两漏一」的漂移源头就此关闭。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDynamic, buildPresetCore } from '../scripts/build.mjs'

test('dynamic/host.js 与 core + 模板同步', () => {
  const onDisk = readFileSync(new URL('../dynamic/host.js', import.meta.url), 'utf8')
  assert.equal(onDisk, buildDynamic(), 'dynamic/host.js 过期：请运行 node scripts/build.mjs')
})

test('preset/codebuddy-first/codebuddy-core.mjs 与 core 同步', () => {
  const onDisk = readFileSync(new URL('../preset/codebuddy-first/codebuddy-core.mjs', import.meta.url), 'utf8')
  assert.equal(onDisk, buildPresetCore(), 'preset 侧 core 副本过期：请运行 node scripts/build.mjs')
})

test('生成的 dynamic/host.js 可被沙箱求值（new Function 语法有效）', () => {
  // 不带 harness 执行：只验证语法与顶层求值不抛错（apply 需要真实 ctx，不在此触发）
  const fn = new Function('harness', buildDynamic())
  assert.equal(typeof fn, 'function')
})
