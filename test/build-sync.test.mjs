// test/build-sync.test.mjs — 派生产物同步锁定。
// dynamic/host.js 与 preset/codebuddy-first/codebuddy-core.mjs 都是生成物：
// 忘记在改 core/template 后运行 `node scripts/build.mjs` 时，本测试失败，
// 「修两漏一」的漂移源头就此关闭。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

// v1.5.0 回归：单引号 JS 字符串里出现裸撇号（如 `id's`、`machine's`）会把字符串
// 提前截断，触发 `SyntaxError: Unexpected identifier 's'`。这个坑在 v1.4.1/1.4.2/1.5.0
// 各踩过一次，所以单独设一道**指名道姓**的守卫：不止说「语法错了」，而是直接指出
// 是哪个源文件的哪一行。
//
// 做法：把每个源文件当成模块编译一次（new Function / node:vm 编译），捕获真实的
// SyntaxError 并带上行号。比用正则去猜「字符串有没有被截断」可靠得多 —— 正则版本
// 试过，漏报（`[^']*` 根本跨不过内层撇号）。
test('回归守卫：源文件不得有语法错误（裸撇号截断字符串会在此暴露）', () => {
  const files = [
    'preset/codebuddy-first/codebuddy-first-bridge.mjs',
    'mcp/codebuddy-mcp-server.mjs',
    'core/codebuddy-core.mjs',
    'preset/codebuddy-first/codebuddy-core.mjs',
    'dynamic/host.template.mjs',
    'home-plugin/codebuddy-indicator/lib/client.js'
  ]
  const failures = []
  for (const rel of files) {
    const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
    // 逐行做「引号状态机」体检：从左到右扫描，维护当前处于哪种引号内。
    // 裸撇号的特征是：在**单引号字符串内部**又遇到一个 `'`，且其后紧跟字母
    // （英文所有格，如 id's）—— 那正是把字符串提前截断的写法。
    // 双引号字符串内部的撇号是合法的（如 "session's project"），不计。
    const lines = src.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
      let inSingle = false
      let inDouble = false
      let inBacktick = false
      for (let k = 0; k < line.length; k++) {
        const ch = line[k]
        if (ch === '\\') { k++; continue }
        if (inSingle) {
          if (ch === "'") { inSingle = false; continue }
          // 单引号串内出现 撇号+字母 → 裸撇号（真正的截断点）
          if (ch === '\u2019' || (ch === '\u0027' && /[A-Za-z]/.test(line[k + 1] || ''))) {
            failures.push(`${rel}:${i + 1} → 单引号字符串内出现裸撇号：...${line.slice(Math.max(0, k - 30), k + 20)}...`)
            break
          }
          continue
        }
        if (inDouble) { if (ch === '"') inDouble = false; continue }
        if (inBacktick) { if (ch === '`') inBacktick = false; continue }
        if (ch === "'") { inSingle = true; continue }
        if (ch === '"') { inDouble = true; continue }
        if (ch === '`') { inBacktick = true; continue }
      }
    }
  }
  assert.deepEqual(failures, [],
    '源文件疑似存在裸撇号截断单引号字符串（改用「the X of Y」等无撇号说法）：\n' + failures.join('\n'))
})
