# Xiaomi MiMo 桌面版「假死」事故报告

- **提交日期**：2026-09-13
- **应用**：Xiaomi MiMo 桌面版（小米 MiMo AI 助手 / mimocode 引擎）
- **版本**：26.912.121036（ProductVersion 26.912.65535.0）
- **安装路径**：`C:\Program Files\Xiaomi MiMo\Xiaomi MiMo.exe`
- **故障等级**：功能完全不可用（应用假死，须强制结束进程），一晚复发 5 次以上
- **是否可复现**：是（复现步骤见第七节）

---

## 一、摘要

在 Windows 11 上使用 Xiaomi MiMo 桌面版时，在项目会话中发送一条消息后，**主进程（同时承载内嵌 mimocode 引擎 HTTP 服务）的 JS 事件循环被长期阻塞**，导致：

1. 本地引擎 `http://127.0.0.1:4096` 完全无响应（假死前同一接口 3~8ms 返回）；
2. 渲染进程（UI）所有数据请求石沉大海，**界面假死**（窗口未崩溃、显示"正在响应"，但无任何反馈）；
3. 主进程持续空转（约 33% 单核 CPU，20 分钟以上不恢复）；
4. 主进程**资源持续泄漏**：句柄以约 30 个/秒增长（累计 53,501 → 57,862），内存持续增长（2.6GB → 3.0GB）；
5. 上一会话曾被 Windows WER 记录 **`RADAR_PRE_LEAK_64` 资源泄漏诊断事件**（事件 ID 1001，报告 ID `c39e207d-ff16-45ba-8ee4-180b781ba661`）。

当晚应用已被迫重启至少 5 次（引擎实例记录 00:42 / 00:56 / 00:57 / 01:57 / 02:00 / 02:04 共 6 任），**每次均在项目会话内发送消息后复发**。

---

## 二、环境信息

| 项目 | 值 |
|---|---|
| 操作系统 | Microsoft Windows 11 企业版 LTSC（build 22631，10.0.22631） |
| 主板/整机 | Onda B760ITX-B4 |
| CPU | 13th Gen Intel Core i5-13490F（10 核 16 线程） |
| 内存 | 32 GB |
| 显卡 | NVIDIA GeForce RTX 5060 Ti 16GB（驱动 610.74，CUDA 13.3） |
| 系统代理 | 已启用，`127.0.0.1:7890`（Clash 类客户端，含 `*.xiaomimimo.com` 走代理规则） |
| 应用版本 | 26.912.121036 |
| 用户数据目录 | `C:\Users\lcl\AppData\Roaming\Xiaomi MiMo` |

---

## 三、故障时间线（2026-09-13 凌晨）

以下时间来自应用日志 `%APPDATA%\Xiaomi MiMo\logs\2026-09-13.log`（共 1144 行）与引擎注册文件。

| 时间 | 事件 |
|---|---|
| 00:37:22 | 应用启动（当日首任进程），日志开始 |
| 00:42:46 | 引擎实例注册 `server-20652-4096.json`（第 2 任进程） |
| 00:56:15 | 引擎实例注册 `server-152168-4096.json`（第 3 任） |
| 00:57:50 | 引擎实例注册 `server-147424-4096.json`（第 4 任，1.5 分钟内再次重启） |
| 01:03:18 | **Windows WER 记录 `RADAR_PRE_LEAK_64`**（Xiaomi MiMo.exe 资源泄漏诊断，事件 1001） |
| 01:57:28 | 应用再次启动（第 5 任进程，PID 18968） |
| 01:57:32 | 日志出现 **`ERR_PROXY_CONNECTION_FAILED`**：加载 `https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me` 失败；`[xiaomi-auth] hidden session preparation failed`；`[win-update] check failed`（当时系统代理客户端未就绪） |
| 01:57:30 | 引擎实例注册 `server-18968-4096.json` |
| 02:00:37 | 引擎实例注册 `server-41472-4096.json`（第 6 任） |
| 02:02:15 | **上一会话日志最后写入**（其后应用假死，被用户手动结束） |
| 02:04:42 | 当前进程启动（PID 9784，第 7 任），主进程同时监听 127.0.0.1:4096 |
| 02:05~02:07 | UI 正常轮询引擎：`GET /experimental/session` 与 `GET /session/status` 均 3~8ms 返回 HTTP 200；日志反复出现 `loadEngineSessions: 原始条数 = 12` 但 `reconcile 后 convos = 0` |
| **02:08:00** | **用户在 Geo-Mapper 项目会话发送一条 73 字符消息**（被分类为 `scene=research, difficulty=hard`，smart-router 路由至云端 `mimo-pro` 模型）；`[harness] session created sid=ses_ffe5f6931f81fffesbJVmfYx0V`；最后一条日志为 `GET /session/ses_ffe5f6931f81fffesbJVmfYx0V/task -> HTTP 200 elapsed=164ms` |
| 02:08:00 之后 | **日志戛然而止，UI 假死至今**。主进程持续 33% 单核 CPU 空转，句柄 +30/s，内存持续增长（详见第五节实测数据） |

---

## 四、故障现象

### 用户视角
- 在项目会话发送消息后，转圈/无任何响应；界面完全无法交互；
- 等待 10 分钟以上无恢复，只能用任务管理器强制结束全部 `Xiaomi MiMo.exe` 进程；
- 重启后再次发消息，故障重现；当晚循环 5 次以上。

### 技术视角（故障现场实测）
- **5 个进程全部存活**，任务管理器显示"正在响应"（非崩溃、非白屏未响应）：
  - PID 9784 主进程（Electron main + mimocode 引擎 HTTP 服务，监听 `127.0.0.1:4096`）
  - PID 11104 渲染进程（**CPU 0%，完全空闲**，工作集 229MB 正常）
  - PID 5200 GPU 进程、PID 30228 网络服务、PID 23544 crashpad
- **引擎 HTTP 服务完全无响应**：`GET http://127.0.0.1:4096/session/status` 5 秒超时（假死前同一接口 3~8ms 返回）；`netstat` 显示 4096 端口有一条 ESTABLISHED 自连接长期挂起；
- **主进程单线程忙循环**：线程 3444 自进程启动（02:04:42）起一直处于 `Running` 状态，独占主进程 99% 以上 CPU 时间，其余线程全部 `Wait`；
- **资源泄漏（持续观测）**：

| 时刻 | 累计 CPU | 工作集 | 句柄数 |
|---|---|---|---|
| 02:18（启动后 14 分钟） | 180s | 2663 MB | ~53,501 |
| 02:20 | 239s | 2,751 MB | +308（10 秒内） |
| 02:27（启动后 22 分钟） | 352s | 3,002 MB | 57,862 |

- **日志管道同步停摆**：渲染进程日志（`[sess-diag]` 等）与主进程日志（`[harness]` 等）同时停止在 02:08:00——渲染进程日志经由主进程转发，主进程阻塞后一并失效。

---

## 五、证据清单

### 5.1 日志摘录（`%APPDATA%\Xiaomi MiMo\logs\2026-09-13.log`）

发消息前（一切正常，30 秒轮询）：
```
02:07:50 [log] [sess-diag] engineFetch GET /experimental/session?roots=true&limit=2000 -> HTTP 200 elapsed=6ms engineUrl= http://127.0.0.1:4096 engineId= (default)
02:07:50 [log] [sess-diag] engineFetch GET /session/status -> HTTP 200 elapsed=3ms engineUrl= http://127.0.0.1:4096 engineId= (default)
```

用户发送消息（最后的正常记录）：
```
02:07:59 [info] [query-classification] result {"origin":"c1789236479436-1","scene":"research","sceneConfidence":0.9179,"difficulty":"hard","difficultyConfidence":0.9601,...}
02:07:59 [info] [smart-router] {"origin":"c1789236479436-1","model":"mimo-pro"}
02:08:00 [info] [harness] session created sid=ses_ffe5f6931f81fffesbJVmfYx0V
02:08:00 [info] [harness] session origin=c1789236479436-1 sid=ses_ffe5f6931f81fffesbJVmfYx0V source=user msgLen=73
02:08:00 [log] [sess-diag] engineFetch GET /session/ses_ffe5f6931f81fffesbJVmfYx0V/task -> HTTP 200 elapsed=164ms engineUrl= http://127.0.0.1:4096 engineId= mimocode
```
**此后 14 分钟以上再无任何日志写入。**

上一会话的代理故障（01:57:32）：
```
01:57:32 [error] (node:18968) electron: Failed to load URL: https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me with error: ERR_PROXY_CONNECTION_FAILED
01:57:32 [error] [xiaomi-auth] hidden session preparation failed Error: ERR_PROXY_CONNECTION_FAILED (-130) loading 'https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me'
01:57:37 [warn] [win-update] error (silent): net::ERR_PROXY_CONNECTION_FAILED
```

异常的会话对账（每 30 秒重复，始终为 0）：
```
02:05:20 [log] [sess-diag] loadEngineSessions: 原始条数 = 12
02:05:20 [log] [sess-diag] loadEngineSessions: reconcile 后 convos = 0 order = 0
```

### 5.2 Windows 事件日志（应用程序日志）
```
时间: 2026/9/13 1:03:18
事件 ID: 1001，来源: Windows Error Reporting
事件名称: RADAR_PRE_LEAK_64
P1: Xiaomi MiMo.exe
P2: 26.912.65535.0
P3: 10.0.22631.2.0.0
报告 ID: c39e207d-ff16-45ba-8ee4-180b781ba661
```
（RADAR_PRE_LEAK_64 为 Windows 资源泄漏诊断的预报告，表明系统检测到该进程存在内存/资源持续增长且超出阈值。）

### 5.3 进程/线程证据（PowerShell 实测，故障现场）
```
主进程 PID 9784：
  线程 3444  State=Running  CPU=239s→289s→352s（持续增长，独占全进程 99% CPU）
  其余线程全部 Wait
  句柄 53,501 → 57,862（约 +30/秒持续泄漏）
  工作集 2663MB → 3002MB（持续增长）

引擎端口：
  TCP 127.0.0.1:4096  LISTENING  PID 9784
  TCP 127.0.0.1:4096 <-> 127.0.0.1:49635  ESTABLISHED（长期挂起的自连接）

引擎健康检查：
  GET http://127.0.0.1:4096/session/status → 5 秒超时无响应
```

### 5.4 触发项目的文件系统事实
会话所在项目：`C:\Users\lcl\Desktop\Geo-Mapper (1)\Geo-Mapper`
- **44,821 个文件，5.0 GB**；
- **git 跟踪文件 48,909 个**，`.git` 目录 **1.55 GB**，`.git/index` 7.1 MB；
- **项目根目录没有 `.gitignore`**，导致完整 Python 虚拟环境（`geo_mapper_venv/`）、OpenCV 构建树（`third_party/opencv/build/`，含 .pdb 调试符号）、VS 构建产物（`build_release_vs2022_x64/`）全部暴露给 git 与 agent 扫描；
- 参考：在该仓库上执行 `git status` 仅需 0.3 秒，说明 git 本身不是瓶颈，瓶颈在引擎自身的处理循环。

### 5.5 历史引擎实例（`%APPDATA%\Xiaomi MiMo\mimocode\llm-server\221de...\`）
```
server-20652-4096.json   00:42:46
server-152168-4096.json  00:56:15
server-147424-4096.json  00:57:50
server-18968-4096.json   01:57:30
server-41472-4096.json   02:00:37
server-9784-4096.json    02:04:49   ← 当前
```
即 00:42~02:04 间应用被重启 6 次；`apm-reported-crashes.json` 内容为 `[]`（**无崩溃上报——全部为假死，非崩溃**）。

---

## 六、根因分析

> 以下按证据强度分层。【事实】为现场实测/日志直接证明；【推断】为基于事实的合理推断，供贵方定位参考。

### 6.1 直接原因【事实】
**主进程 Node.js 事件循环被一个同步长任务/忙循环长期阻塞**（线程 3444 自启动起持续 Running）。由于 mimocode 引擎的 HTTP 服务（127.0.0.1:4096）与 Electron 主进程运行在同一进程、同一 JS 线程，事件循环阻塞导致：
- 引擎 HTTP 完全无响应 → UI 所有 `engineFetch` 请求挂起 → **界面假死**；
- 主进程与渲染进程之间的日志转发停摆 → 日志同时停止。

### 6.2 架构性缺陷【事实 + 推断】
- 引擎未运行在独立进程/Worker 线程中，与 UI 壳同生共死；
- 引擎 HTTP 调用方（渲染进程）无超时与降级机制，请求无限等待；
- 主进程无看门狗（watchdog），事件循环阻塞 20 分钟以上不会自杀/恢复/提示用户。

### 6.3 疑似触发链【推断】
1. 02:08:00 harness agent 会话创建后，引擎开始构建项目上下文（文件树遍历/索引/git 状态对账）并调用云端 `mimo-pro`；
2. Geo-Mapper 为巨型项目（44k 文件、无 .gitignore、venv/构建产物全量暴露），agent 的文件处理量被放大数个数量级；
3. 处理过程中存在**句柄泄漏（+30/s）与内存增长**的代码路径（与 Windows RADAR_PRE_LEAK_64 诊断相互印证），怀疑存在无退避的重试循环或未释放的文件/定时器/套接字资源；
4. 该循环为同步或高频事件驱动，长期霸占事件循环。

### 6.4 疑似加重因素【推断】
- 本机系统代理 `127.0.0.1:7890` 在 01:57 曾不可用（`ERR_PROXY_CONNECTION_FAILED`，代理客户端未就绪）。若引擎对云端 LLM 的请求在"代理监听但上游不可达"的半开状态下无超时/无退避地重试，将同时造成 CPU 空转与句柄/套接字泄漏。建议贵方排查引擎网络层的重试与超时实现。

### 6.5 已排除项【事实】
- ❌ 应用崩溃（崩溃上报为空，进程全部存活）；
- ❌ GPU/显存/本地推理（GPU 利用率 6%，显存 2.9/16.3GB，模型走云端）；
- ❌ 系统资源耗尽（空闲内存 8.5GB/32GB，磁盘充足）；
- ❌ git 命令本身慢（实测 `git status` 0.3 秒）；
- ❌ 渲染进程自身卡死（渲染进程 CPU 0%、内存正常，其假死完全由等待引擎引起）。

---

## 七、可复现故障的操作流程

### 方案 A：本机复现（置信度高，已多次自然复现）

1. **前置条件**：Windows 11；Xiaomi MiMo 桌面版 26.912.121036；已登录；准备一个大型项目目录（本机为 `C:\Users\lcl\Desktop\Geo-Mapper (1)\Geo-Mapper`：44k+ 文件、含 venv 与构建产物、无 .gitignore、.git 1.5GB）。
2. 启动 Xiaomi MiMo，等待首页加载完成。
3. 打开/新建该项目（Geo-Mapper）的会话。
4. 在输入框输入一条研究/分析类消息（本次为 73 字符、被自动分类为 `research/hard` 的问题，例如"帮我分析这个项目的架构并梳理模块依赖"），点击发送。
5. **观察**（预期 10 秒~2 分钟内出现）：
   - 消息发出后 UI 无任何后续响应（无回复、无进度、界面无法交互）；
   - 任务管理器中主进程（占内存最大的 `Xiaomi MiMo.exe`）CPU 持续约 25~35%（单核），不再下降；
   - 主进程句柄数以每秒约 +30 持续增长（1 分钟内从 ~5.3 万涨至 ~5.5 万可见）；
   - `curl http://127.0.0.1:4096/session/status` 超时无响应。
6. 等待 10 分钟以上，故障不自愈；须结束全部 `Xiaomi MiMo.exe` 进程方可恢复。

### 方案 B：干净环境泛化复现（供贵方 QA）

1. 准备一台 Windows 11 测试机，安装同版本 MiMo 桌面版并登录。
2. 构造大型项目目录（模拟"无 .gitignore 的大仓库"）：
   ```powershell
   # PowerShell 示例：生成 ~45000 个文件的仓库
   mkdir C:\test\big-repo; cd C:\test\big-repo
   git init
   # 复制任意 Python venv（或生成海量小文件）：
   python -m venv .venv
   # 再复制/生成若干 GB 级目录树（例如解压 OpenCV 构建产物、重复的小文件）
   # 注意：不添加 .gitignore
   git add -A ; git commit -m init     # 制造 4 万+ 跟踪文件与 7MB+ index
   ```
3. 在 MiMo 中打开 `C:\test\big-repo`，新建会话，发送一条分析类消息。
4. 同时开两个窗口观察：
   - 任务管理器（详细信息页）：主进程 CPU/句柄/内存曲线；
   - 终端：`while($true){ (Get-Process "Xiaomi MiMo" | Sort WS -Desc)[0] | % {"CPU=$([int]$_.CPU)s handles=$($_.HandleCount) WS=$([int]($_.WS/1MB))MB"}; Start-Sleep 5 }`
   - 引擎健康：`curl -m 5 http://127.0.0.1:4096/session/status`（假死时超时）。
5. 记录：从发送消息到 `/session/status` 首次超时的耗时；主进程线程状态（应能看到一个线程持续 Running）。

### 方案 C：变量控制（定位加重因素）

在方案 B 基础上分别单独验证：
- **C1 项目规模**：用同一个干净小项目（<100 文件）发送同样消息 → 预期不触发或很快返回，用于对照；
- **C2 代理状态**：配置系统代理指向 `127.0.0.1:7890` 但不启动代理客户端（或启动后断开上游节点），再执行方案 A/B → 观察是否加速触发 CPU 空转与句柄泄漏（对应 01:57 日志中的 `ERR_PROXY_CONNECTION_FAILED` 场景）；
- **C3 会话数量**：累计创建 10+ 会话后重复发送（本机引擎已累积 12 个会话，且日志显示 `reconcile 后 convos = 0` 的异常对账）→ 观察会话对账逻辑是否参与阻塞。

### 故障现场的取证命令（供复现时留证）
```powershell
# 1. 进程与线程（找到持续 Running 的线程即主线程阻塞证据）
$p = Get-Process "Xiaomi MiMo" | Sort-Object WS -Descending | Select-Object -First 1
$p.Threads | Sort-Object TotalProcessorTime -Descending | Select-Object -First 5 Id, ThreadState, WaitReason, TotalProcessorTime

# 2. 引擎健康（正常应毫秒级返回；假死时超时）
Invoke-WebRequest 'http://127.0.0.1:4096/session/status' -TimeoutSec 5 -UseBasicParsing

# 3. 句柄泄漏速率（间隔 10 秒两次采样对比）
(Get-Process -Id $p.Id).HandleCount

# 4. 日志尾部
Get-Content "$env:APPDATA\Xiaomi MiMo\logs\$(Get-Date -Format yyyy-MM-dd).log" -Tail 30

# 5. Windows 泄漏诊断事件
Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1001} | Where-Object Message -match 'MiMo'
```

---

## 八、预期结果 vs 实际结果

| 项目 | 预期 | 实际 |
|---|---|---|
| 发送消息后 | 引擎返回任务流，UI 显示进度/回复，可继续交互 | UI 完全冻结，无任何反馈 |
| 引擎 HTTP `GET /session/status` | 毫秒级响应 | 5 秒超时无响应 |
| 主进程 CPU | 空闲或短时波动 | 持续 33% 单核 20 分钟以上 |
| 主进程句柄 | 数百~数千，稳定 | 53,501 → 57,862（+30/秒）持续增长 |
| 主进程内存 | 稳定 | 2.6GB → 3.0GB 持续增长 |
| 日志 | 持续记录任务执行 | 02:08:00 后完全停止 |
| 故障自愈/提示 | 超时提示/可中断任务 | 无任何提示，只能强杀进程 |

---

## 九、临时规避措施（用户侧）

1. 故障发生后：任务管理器结束全部 `Xiaomi MiMo.exe` 进程后重启（会话数据在 SQLite/WAL 中，未丢失）；
2. 为大项目补 `.gitignore`（排除 `geo_mapper_venv/`、`third_party/`、`build*/`、`__pycache__/` 等）并 `git rm -r --cached` 清理误跟踪文件，降低 agent 扫描成本；
3. 避免在 MiMo 中对含 venv/构建产物的大目录直接开会话；
4. 定期重启 MiMo（泄漏为渐进式，长时间使用后句柄/内存明显增长）。

---

## 十、修复建议（供贵方参考）

1. **进程隔离**：将 mimocode 引擎从 Electron 主进程迁出（独立子进程 / utilityProcess / Worker 线程），保证引擎阻塞不影响 UI 壳与窗口消息循环；
2. **看门狗与超时**：引擎 HTTP 增加请求超时与队列深度限制；主进程对事件循环做心跳监控（如 `heartbeat` + `watchdog` 计时器），阻塞超阈值时自动提示用户并提供"中断当前任务"；
3. **修复资源泄漏**：排查 harness agent 执行路径上句柄（+30/s）与内存的持续增长点——重点检查文件遍历、重试循环、定时器/套接字未释放路径（Windows 已两次给出 `RADAR_PRE_LEAK_64` 诊断）；
4. **网络层健壮性**：云端 API 请求增加超时、退避重试上限与代理故障降级（对应 `ERR_PROXY_CONNECTION_FAILED` 场景）；
5. **大项目保护**：agent 构建项目上下文时尊重 `.gitignore` 并自带默认忽略清单（`node_modules/`、`venv/`、`build/` 等），对超大目录（>1 万文件）分片异步索引并显示进度；
6. **会话对账异常**：排查 `loadEngineSessions: 原始条数 = 12 → reconcile 后 convos = 0` 的对账逻辑为何持续失败（可能是反馈循环的一部分）。

---

## 十一、附件清单（建议随报告一并提交）

| 附件 | 路径 |
|---|---|
| 完整应用日志（当日） | `C:\Users\lcl\AppData\Roaming\Xiaomi MiMo\logs\2026-09-13.log`（1144 行，567KB） |
| WER 泄漏诊断事件截图/导出 | 事件查看器 → 应用程序日志 → 2026-9-13 01:03:18 事件 1001（RADAR_PRE_LEAK_64，报告 ID c39e207d-ff16-45ba-8ee4-180b781ba661） |
| 引擎实例注册记录 | `C:\Users\lcl\AppData\Roaming\Xiaomi MiMo\mimocode\llm-server\221de2ab3ce3973b1a92332058816818fb28610a\`（6 任实例） |
| 崩溃上报为空的证据 | `C:\Users\lcl\AppData\Roaming\Xiaomi MiMo\apm-reported-crashes.json`（内容 `[]`） |
| 故障现场进程数据 | 本报告第四节/第五节表格（或提交时重新运行第七节取证命令） |
| 触发项目规模数据 | 44,821 文件 / 5.0GB / git 跟踪 48,909 文件 / .git 1.55GB / 无 .gitignore |

---

*报告完*
