/**
 * @file client-entry.mjs
 * @description 【弃用留档】v1.1.7 起标准 npm 分发不再需要本占位：
 * 主包 package.json 的 main/exports["."] 直接指向 ./lib/index.mjs（host 半真
 * 入口），bundle 补丁层（dsh.bundle.patch → cordis.patch.yml）用裸包名
 * codebuddy-first-bridge 一行加载，单实例。本文件仅保留以防旧式安装
 * （用户层裸包名 codebuddy-indicator + junction）的 client-modules 扫描需要
 * require.resolve 命中 package.json 才能发现 dsh.client 声明。
 *
 * 历史（勿删，留档说明为何曾有本占位）：
 * v1.1.2 之前，main/exports["."] 指向本占位而非 lib/index.mjs，因为同一份插件
 * 会被 patch 的两行（file:// 行 + 裸名行）加载成两个模块实例（ESM URL 不同：
 * file://...?v=N vs 裸名解析无查询串），apply 执行两次，index.mjs 里的
 * ctx.provide('codebuddyCollector') 二次注册同名服务 → 后端启动崩溃
 * ("service ... has been registered at <codebuddy-indicator>")。
 * v1.1.7 移除 file:// 行后该问题不复存在，main 直指 index.mjs。
 */
export const name = 'codebuddy-indicator-client'

export function apply() {}
