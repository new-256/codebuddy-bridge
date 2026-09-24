#!/usr/bin/env node
// scripts/deploy.mjs — 把本仓库构建产物部署进 DSH 的 web profile。
//
// 为什么需要它：profile 的依赖是 `file:<repo>`，但 **pnpm 对 file: 依赖不做内容校验** ——
// 只要 lockfile 里的 specifier 没变，`pnpm install` 一律打印 "Already up to date" 并
// 保留 node_modules 里的**旧副本**（实测：package.json 已 1.3.1、core 仍是 1.3.0 代码）。
// 结果是「改了代码、跑了 install、装上去的还是旧的」这种静默失效。
//
// 本脚本的做法：先删掉部署副本再 install，强制 pnpm 重新物化，然后逐文件哈希核对。
//
// 用法：
//   node scripts/deploy.mjs            # 构建 + 部署 + 校验
//   node scripts/deploy.mjs --no-build # 跳过构建（只部署当前产物）

import { existsSync, rmSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || join(process.env.APPDATA || '', 'DSH Desktop', 'dsh-home')
const WEB = join(DSH_HOME, 'profiles', 'web')
const DEP = join(WEB, 'node_modules', 'codebuddy-first-bridge')
const PNPM = process.env.DSH_PNPM || join(process.env.APPDATA || '', 'DSH Desktop', 'backend', 'pnpm.CMD')

// 必须与仓库逐字节一致的关键产物（漏一个就是「装上去的还是旧的」）
const CRITICAL = [
  'package.json',
  'core/codebuddy-core.mjs',
  'preset/codebuddy-first/codebuddy-core.mjs',
  'preset/codebuddy-first/codebuddy-first-bridge.mjs',
  'dynamic/host.js',
  'mcp/codebuddy-mcp-server.mjs',
  'home-plugin/codebuddy-indicator/lib/preset-definition.mjs',
  'home-plugin/codebuddy-indicator/lib/index.mjs',
  'home-plugin/codebuddy-indicator/lib/client.js'
]

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const log = (s) => console.log(s)

if (!existsSync(WEB)) {
  console.error(`✗ 找不到 DSH web profile：${WEB}\n  可用 DSH_HOME 环境变量覆盖。`)
  process.exit(1)
}
if (!existsSync(PNPM)) {
  console.error(`✗ 找不到 pnpm：${PNPM}\n  可用 DSH_PNPM 环境变量覆盖。`)
  process.exit(1)
}

// 1) 构建（保证产物与源码同步；--check 会因不同步而非零退出）
if (!process.argv.includes('--no-build')) {
  log('▸ 构建产物…')
  execFileSync(process.execPath, [join(REPO, 'scripts', 'build.mjs')], { cwd: REPO, stdio: 'inherit' })
  try {
    execFileSync(process.execPath, [join(REPO, 'scripts', 'build.mjs'), '--check'], { cwd: REPO, stdio: 'pipe' })
    log('  ✓ 产物与源码同步')
  } catch {
    console.error('  ✗ build --check 失败：产物与源码不同步，已中止（先跑 node scripts/build.mjs）')
    process.exit(1)
  }
}

// 2) 备份 + 删除部署副本（这一步才是真正让 pnpm 重新物化的关键）
if (existsSync(DEP)) {
  const bak = join(WEB, 'node_modules', '.codebuddy-first-bridge.bak')
  rmSync(bak, { recursive: true, force: true })
  execFileSync(process.platform === 'win32' ? 'cmd' : 'cp',
    process.platform === 'win32' ? ['/c', 'xcopy', DEP, bak, '/E', '/I', '/Q', '/Y'] : ['-r', DEP, bak],
    { stdio: 'ignore' })
  rmSync(DEP, { recursive: true, force: true })
  log(`▸ 已备份旧副本 → ${bak}`)
}

// 3) 重新物化
log('▸ pnpm install（重新物化 file: 依赖）…')
// 不调用 pnpm.CMD / pnpm.ps1：DSH 装在 "DSH Desktop"（含空格），而 Windows 下 .CMD 必须
// 经 shell:true 才能被 Node ≥ 20 执行，shell 又不会给参数加引号 → EINVAL / 退出 1。
// 改为用当前 node 直接跑 corepack 的 pnpm.js（纯 JS 入口，无 shell，空格安全）。
const PNPM_JS = process.env.DSH_PNPM_JS || join(dirname(PNPM), 'node_modules', 'corepack', 'dist', 'pnpm.js')
const pnpmCmd = existsSync(PNPM_JS) ? [process.execPath, [PNPM_JS, 'install', '--prefer-offline']] : null
if (!pnpmCmd) {
  console.error(`✗ 找不到 pnpm 的 JS 入口：${PNPM_JS}\n  可用 DSH_PNPM_JS 环境变量覆盖。`)
  process.exit(1)
}
execFileSync(pnpmCmd[0], pnpmCmd[1], { cwd: WEB, stdio: 'inherit' })

// 4) 逐文件哈希核对
log('\n▸ 逐文件核对（仓库 vs 部署）')
let bad = 0
for (const rel of CRITICAL) {
  const a = join(REPO, rel)
  const b = join(DEP, rel)
  if (!existsSync(a)) { log(`  ! ${rel.padEnd(56)} 仓库缺失`); continue }
  if (!existsSync(b)) { log(`  ✗ ${rel.padEnd(56)} 部署缺失`); bad++; continue }
  if (sha(a) !== sha(b)) { log(`  ✗ ${rel.padEnd(56)} 内容不一致`); bad++ }
  else log(`  ✓ ${rel.padEnd(56)} 一致`)
}

if (bad) {
  console.error(`\n✗ 部署校验失败：${bad} 个文件不一致。`)
  process.exit(1)
}

const ver = JSON.parse(readFileSync(join(DEP, 'package.json'), 'utf8')).version
log(`\n✓ 部署完成，版本 ${ver}`)
log('  请重启 DSH（或确认 profile 的 patchReload 生效）后，检查 preset 列表里 codebuddy-first 是否在列。')
