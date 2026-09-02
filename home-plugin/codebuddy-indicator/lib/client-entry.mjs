/**
 * @file client-entry.mjs
 * @description 组合树里 name: codebuddy-indicator 裸名行的宿主半边入口 —— 空操作占位。
 * 真正的宿主逻辑在 cordis.patch.yml 的 file:// 行。
 *
 * 为什么存在（v1.1.2 更新说明）：
 * DSH Desktop ≥ 0.3.14（dsh 0.1.2-alpha.5）的 client-modules 扫描所有 Loader 行
 * （file:// 行经 nearestPackage 上溯到 package.json 同样命中 dsh.client 声明），
 * 裸名行不再是花名册发现的必要条件；但更早版本只扫裸包名行（require.resolve
 * 必须命中），本占位 + 裸名行保持旧版兼容。
 *
 * main/exports["."] 必须指向本占位而非 lib/index.mjs 的原因（继承自
 * agy-first-bridge v1.5.4 的崩溃修复）：若指向 index.mjs，同一份插件会被 patch 的
 * 两行（file:// 行 + 裸名行）加载成两个模块实例（ESM URL 不同：file://...?v=N vs
 * 裸名解析无查询串），apply 执行两次，index.mjs 里的 ctx.provide
 * ('codebuddyCollector') 二次注册同名服务 → 后端启动崩溃
 * ("service ... has been registered at <codebuddy-indicator>")。
 */
export const name = 'codebuddy-indicator-client'

export function apply() {}
