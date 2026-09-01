/**
 * @file client-entry.mjs
 * @description 组合树里 name: codebuddy-indicator 裸名行的宿主半边入口 —— 空操作占位。
 * 真正的宿主逻辑在 cordis.patch.yml 的 file:// 行。
 *
 * 为什么必须存在（继承自 agy-first-bridge v1.5.4 的崩溃修复）：
 * 宿主侧 client-modules 只扫描「裸包名」行（require.resolve(name/package.json)
 * 必须命中）才能发现 package.json 的 dsh.client 声明，把 client.js 纳入浏览器
 * 花名册。因此 package.json 的 main/exports["."] 必须指向本占位而非 lib/index.mjs：
 * 若指向 index.mjs，同一份插件会被 patch 的两行（file:// 行 + 裸名行）加载成两个
 * 模块实例（ESM URL 不同：file://...?v=N vs 裸名解析无查询串），apply 执行两次，
 * index.mjs 里的 ctx.provide('codebuddyCollector') 二次注册同名服务 → 后端启动崩溃
 * ("service ... has been registered at <codebuddy-indicator>")。
 */
export const name = 'codebuddy-indicator-client'

export function apply() {}
