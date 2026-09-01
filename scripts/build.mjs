#!/usr/bin/env node
// scripts/build.mjs — 从规范 core 生成两个派生产物：
//   1. dynamic/host.js           （core 文本注入 dynamic/host.template.mjs：
//                                  Cordis 动态插件沙箱禁止 import，只能文本注入）
//   2. preset/codebuddy-first/codebuddy-core.mjs
//                                （core 的原样副本：preset 通过相对 './codebuddy-core.mjs'
//                                  导入，使安装到 .agent-presets/codebuddy-first/ 的目录
//                                  自包含、无外部依赖）
// MCP server 直接 import '../core/codebuddy-core.mjs'（从仓库运行，无需派生）。
//
// 同步测试（test/build-sync.test.mjs）会重新生成并比对两个产物，锁定一致性：
// 改了 core 或 template 而忘记重新生成时 CI 会失败。
//
// Usage: node scripts/build.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function buildDynamic() {
  const core = readFileSync(join(root, 'core', 'codebuddy-core.mjs'), 'utf8')
  const template = readFileSync(join(root, 'dynamic', 'host.template.mjs'), 'utf8')
  // 标记必须恰好出现一次（防止注释里误写标记文本导致注入错位）。
  const occurrences = template.split('/*__CORE__*/').length - 1
  if (occurrences !== 1) throw new Error('host.template.mjs must contain exactly one /*__CORE__*/ marker, found ' + occurrences)
  // 剥离模块导出关键字，使核心成为普通声明（沙箱函数体内合法）。
  const coreBody = core.replace(/^export /gm, '')
  // 用函数替换避免 $ 系列替换模式被意外展开。
  return template.replace('/*__CORE__*/', () => coreBody)
}

export function buildPresetCore() {
  return readFileSync(join(root, 'core', 'codebuddy-core.mjs'), 'utf8')
}

const isMain = process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replace(/\\/g, '/')).href
if (isMain) {
  const check = process.argv.includes('--check')
  const artifacts = [
    { path: join(root, 'dynamic', 'host.js'), content: buildDynamic(), label: 'dynamic/host.js' },
    { path: join(root, 'preset', 'codebuddy-first', 'codebuddy-core.mjs'), content: buildPresetCore(), label: 'preset/codebuddy-first/codebuddy-core.mjs' }
  ]
  if (check) {
    let bad = false
    for (const a of artifacts) {
      const current = readFileSync(a.path, 'utf8')
      if (current !== a.content) {
        console.error(a.label + ' is OUT OF SYNC with core/template. Run: node scripts/build.mjs')
        bad = true
      } else {
        console.log(a.label + ' is in sync (' + a.content.length + ' chars)')
      }
    }
    if (bad) process.exit(1)
  } else {
    for (const a of artifacts) {
      writeFileSync(a.path, a.content)
      console.log(a.label + ' generated (' + a.content.length + ' chars)')
    }
  }
}
