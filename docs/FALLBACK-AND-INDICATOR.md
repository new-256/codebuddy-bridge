# 回退机制与状态灯

本文档说明用户要求的两项能力：**codebuddy 受限时的回退弹窗**，以及**实时状态灯**。

---

## 一、回退机制（弹窗确认）

### 触发条件

`codebuddy_run` / `codebuddy_continue` 每次执行后，若结果 `ok === false` 且被判定为「疑似流量受限 / 网络不通」，就会触发回退弹窗。判定 `isLimited(res)` 命中任一即可：

- `status` 为 `SPAWN_ERROR` 或 `CODEBUDDY_UNAVAILABLE`（进程起不来 / 找不到 codebuddy）；
- `stderr` + `response` + `status` 拼起来命中以下正则（大小写不敏感）：

  ```
  rate limit / ratelimit / 429 / too many / quota / exceed /
  network / offline / ENETUNREACH / ECONNREFUSED / ECONNRESET /
  ETIMEDOUT / EAI_AGAIN / ENOTFOUND / timeout / timed out /
  unavailable / 503 / 502 / 500 / connection / proxy / socket /
  tls / ssl / dns / 网络 / 超时 / 限流 / 流量 / 受限 / 配额 / 连接 / 断开
  ```

### 弹窗内容

通过 DSH 的 `userQuestions.ask()` 弹出一个单选题：

> **codebuddy 受限** —— codebuddy 调用失败（疑似流量受限/网络不通，状态=`<status>`）。是否改用 DSH 本地 API 配置继续？

三个选项：

| 选项 | 行为 |
| --- | --- |
| **使用 DSH 本地 API 配置（回退）** | 返回 `{ ok:false, fallback:true, status:'FALLBACK_TO_DSH', reason:<原status> }`。模型据此改用**原生工具 / 本地模型**完成任务，且不再调用 codebuddy。 |
| **重试 codebuddy 一次** | 立即再执行一次 codebuddy（最多累计 2 次）。 |
| **不回退（返回错误）** | 原样返回 codebuddy 错误结果，由模型决定后续。 |

### 防阻塞 / 防循环设计

- **无真人应答者时不弹窗**：`userQuestions.ask()` 只对「当前存活的运行根」有效。若调用来自被托管的子代理（`exec.agent` 非存活根，或被其他 agent 拥有），`ask()` 会抛 `CALLER_NOT_LIVE` / `DELEGATED_CALLER`；本插件捕获后按 `'error'` 处理（不弹窗、直接返回错误），避免子代理永久卡住。缺少 `userQuestions` 服务时同理。
- **最多 2 次尝试**：主循环 `attempt >= 2` 即停，杜绝反复重试。
- **后台任务不弹窗**：`background:true` 的任务在 `jobs` 里异步跑，完成时真人上下文未必还在，因此后台失败**不**触发弹窗——工具返回里也提示「前台重跑才会被询问」。
- **不让 codebuddy 回调 DSH**：策略提示明确禁止 codebuddy 反向调用 DSH，避免环路。

### 模型侧约定（提示段）

插件注入的 `codebuddy:policy` 提示段包含如下约定，确保模型正确消费回退结果：

> 当 codebuddy 被限流或网络不通时，codebuddy_run/codebuddy_continue 会自动弹窗询问是否使用 DSH 本地 API 配置。若返回 `fallback=true`（`status FALLBACK_TO_DSH`），表示用户选择回退：请用原生 DSH 工具 / 本地模型完成本任务，且**不要**再调用 codebuddy。若 `ok=false` 但没有 `fallback`，报告 codebuddy 错误。绝不循环调用 codebuddy；绝不让 codebuddy 回调 DSH。

### 时序

```
codebuddy_run
  └─ runSync ──▶ 结果 res
       ├─ res.ok?                         ──▶ 返回成功
       ├─ !isLimited(res)?                ──▶ 原样返回错误
       └─ isLimited(res):
            askFallback(exec, res)
              ├─ 无真人应答者              ──▶ 返回错误
              ├─ 选「回退」                ──▶ 返回 { fallback:true, FALLBACK_TO_DSH }
              ├─ 选「重试」且 attempt<2     ──▶ 再跑一次
              └─ 选「不回退」              ──▶ 原样返回错误
```

---

## 二、实时状态灯（动态形态 + 家级插件，随软件启动）

### 位置与外观

状态灯注册在浏览器会话标题栏右侧的 Slot `conversation.session.header.utilities`（家级灯 id：`codebuddy-indicator-home`），是一枚「彩色圆点 + 文案」的小胶囊，鼠标悬停显示 `state / running / last / session` 详情。

| 状态 `state` | 圆点颜色（主题 token） | 文案 |
| --- | --- | --- |
| `running` | 静态蓝 `--dsw-static-blue-500`（#3b82f6，呼吸动画；brand-primary 解析为近黑、辨识度低故不用） | `CB 工作中`（并发多个时显示 `×N`） |
| `ok` | 静态绿 `--dsw-static-green-500`（#22c55e） | `CB` |
| `failed` | 错误色 `--dsw-alias-state-error-primary` | `CB 失败` |
| `fallback` | 警告色 `--dsw-alias-state-warn-primary` | `本地回退` |
| `idle` | 次要文字色 `--dsw-alias-label-secondary` | `CB 就绪` |

所有颜色都取自 DSH 主题 token，因此自动适配明暗主题。

### 数据来源（两条通道）

**通道一（动态形态 → 家级收集器）**：动态沙箱无 `ctx.emit`，Host 半通过家级插件 `ctx.provide` 暴露的 `codebuddyCollector` 服务把状态推入同一张全局项目表，由家级灯统一渲染；同时 Host 保留 `harness.handle('codebuddy_status', () => snapshot())` 只读 RPC 作为包私有的查询通道（快照只含标量字段，不含任何 Host 活对象引用）。

**通道二（preset 形态，事件推送 + HTTP）**：preset 形态（真 Node 模块）每次 `begin`/`end`/`foldEvent` 后 `ctx.emit('codebuddy/status', { snapshot })`；家级插件 `codebuddy-indicator` 的 host 半 `ctx.on('codebuddy/status')` 收集并按 cwd 合并成全局项目表，经 `webServer` 暴露 `GET /codebuddy-indicator/status`；家级 client 半每 1.2s `fetch` 该路由渲染同样的灯。**随软件启动、所有会话自动显示、无需审批**。

### 一次性审批（仅动态形态）

动态形态的 Client 半首次运行时，DSH GUI 会请求审批（Cordis 的单勾/双勾授权机制）。批准后状态灯即出现。若会话禁用了审批提示，Client 半会被自动拒绝——此时回退弹窗仍可用，只是没有动态灯（**家级灯不受影响**）。

### 为什么 Preset 形态本身没有状态灯

Preset 是 Host 面组合，其 `.mjs` 只在 Node 侧运行、不含浏览器 UI；浏览器 UI 必须由 Client 面组件提供。**本项目通过家级插件（`home-plugin/codebuddy-indicator/`，`cordis.patch.yml` 注册）补齐**：它带独立的 host 半（收集事件 + HTTP 路由）与 client 半（浏览器灯），preset 只需在状态变化时 `ctx.emit('codebuddy/status')` 推送即可，无需发布额外 client bundle 或重建 web 产物。回退弹窗是 Host 能力，preset 与动态两种形态都具备。
