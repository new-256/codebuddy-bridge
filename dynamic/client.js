// dynamic/client.js
//
// code.client body for the in-session (dynamic) Cordis plugin variant.
//
// 继承 agy-first-bridge v1.5.4+ 的设计：动态形态不再渲染自己的标题栏灯。
// 全软件只保留一个灯——家级 codebuddy-indicator（cordis.patch.yml 注册，随软件
// 启动）。动态形态的状态通过家级 host 暴露的 codebuddyCollector 服务
// （ctx.provide('codebuddyCollector')）推送进家级收集器，由家级灯统一显示：
//
//   - codebuddy 优先模式（preset）会话：家级灯常驻（含 "CB 就绪" 占位）
//   - 普通模式会话：家级灯仅在调用 codebuddy 时临时显示（running/ok/failed）
//
// 因此本 client 半是最小骨架：不注入 slots、不注册 UI、不产生任何副作用。
// （Cordis 动态插件可以只有 host 半；这里保留 client 半返回空插件对象，
//   仅为与参考实现结构兼容。）
//
// 注意：本文件是「函数体」（顶层 return 一个 Plugin 对象），不是可独立运行的
// 模块——粘贴进 cordis_define 的 code.client 字段使用。

return {
  inject: [],
  apply(ctx) {
    // 动态形态的 UI 统一由家级 codebuddy-indicator 呈现；此处无操作。
  }
}
