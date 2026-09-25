// codebuddy-indicator — browser half (home-level plugin).
//
// 会话标题栏右侧的状态灯：每 1.2s 轮询 /codebuddy-indicator/status
//
//   running  → 蓝色呼吸圆点, "⟳ CB [×N]"
//   ok       → 绿色圆点, "✓ CB"
//   failed   → 红色圆点, "✗ CB"
//   fallback → 琥珀色圆点, "↩ CB"
//   idle     → 灰色圆点, "CB"
//
// 可见性（v1.1.1 起）：活动灯（项目 pill）全局显示；「CB 就绪」空转灯只在该会话
// 本身处于 codebuddy-first 模式时显示。判定走两条独立通道，**任一肯定即肯定**：
//   ① host 端点的 presetSessions 名单（v1.1.3 起，权威）——host 实时枚举
//      agents.list() + agentPresets.composedPreset()，对已开会话立即生效；
//   ② DSH 客户端会话摘要（新框架 ≥0.3.14 经标准 props sessionId + useSessions 读
//      projectionValues.agentPreset；旧框架经 inject(sessionId) + sessions.list）。
// 都不肯定时才用名单做否定；两者皆无结论则回退全局 presetActive（心跳租约）。
// v1.1.2 只有通道 ②，而默认会话本就没有 agentPreset 字段 → 判「未知」→ 回退全局
// 租约 → 普通会话仍亮灯；通道 ① 就是为消除这个漏洞加的。

window.__ModuleLoader__.load({
  // ⚠ 注册 id 必须等于【包名】codebuddy-first-bridge：client-modules 的 graph row
  // 以 package name 为 id（exports["./client"] 的归属包），bundle 脚本执行后按
  // "loaded without registering \"<packageName>\"" 校验注册名。v1.1.7 及以前写成
  // "codebuddy-indicator"（旧独立包名），包改名并入 codebuddy-first-bridge 后
  // 不匹配 → 整个 client combo 加载失败 → DSH 启动致命屏（2026-09-10 18:08 事故）。
  // v1.1.8 修正为与包名一致。slot id 'codebuddy-indicator-home' 与 CSS 标记是
  // 另一命名空间，无需改。
  id: "codebuddy-first-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");

    const CSS = [
      ".cb-ind{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap;user-select:none}",
      ".cb-ind:hover{border-color:var(--dsw-alias-border-l2);cursor:pointer}",
      ".cb-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-label-secondary)}",
      ".cb-ind b{font-weight:600}",
      ".cb-run .cb-dot{background:var(--dsw-static-blue-500,#3b82f6);animation:cb-pulse 1s ease-in-out infinite}",
      ".cb-ok .cb-dot{background:var(--dsw-static-green-500,#22c55e)}",
      ".cb-fail .cb-dot{background:var(--dsw-alias-state-error-primary)}",
      ".cb-fb .cb-dot{background:var(--dsw-alias-state-warn-primary)}",
      ".cb-run{color:var(--dsw-static-blue-500,#3b82f6);border-color:var(--dsw-static-blue-500,#3b82f6)}",
      ".cb-ok{color:var(--dsw-static-green-500,#22c55e);border-color:var(--dsw-static-green-500,#22c55e)}",
      ".cb-fb{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}",
      "@keyframes cb-pulse{0%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.72)}100%{opacity:1;transform:scale(1)}}",
      ".cb-pop-overlay{position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:10000;display:flex;align-items:center;justify-content:center}",
      ".cb-pop-panel{width:520px;max-width:92vw;max-height:76vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow:hidden}",
      ".cb-pop-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600}",
      ".cb-pop-close{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;width:22px;height:22px;line-height:1;font-size:13px;cursor:pointer}",
      ".cb-pop-close:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
      ".cb-pop-body{overflow:auto;padding:12px 14px}",
      ".cb-pop-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:18px 0}",
      ".cb-pop-proj{margin-bottom:12px;padding-bottom:12px;border-bottom:1px dashed var(--dsw-alias-border-l1)}",
      ".cb-pop-proj:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}",
      ".cb-pop-proj-head{font-weight:600;margin-bottom:4px}",
      ".cb-pop-mono{font-family:Consolas,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".cb-pop-line{padding:1px 0}",
      ".cb-pop-cur{background:rgba(59,130,246,.12);border-radius:4px;padding:3px 6px;margin:4px 0}",
      ".cb-pop-cur .cb-pop-mono{color:var(--dsw-alias-label-primary)}",
      // ── v1.3.2 设置面板（settings.section 分区）──────────────────────────────
      ".cbs-root{display:flex;flex-direction:column;gap:14px;max-width:680px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}",
      ".cbs-h{font-size:14px;font-weight:600}",
      ".cbs-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}",
      ".cbs-grid{display:grid;grid-template-columns:130px 1fr;gap:8px 12px;align-items:center}",
      ".cbs-label{color:var(--dsw-alias-label-secondary);text-align:right;font-size:12px}",
      ".cbs-ctl{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".cbs-note{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px}",
      ".cbs-input,.cbs-select{width:100%;box-sizing:border-box;height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-input,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;outline:none}",
      ".cbs-input:focus,.cbs-select:focus{border-color:var(--dsw-alias-border-brand,var(--dsw-static-blue-500,#3b82f6))}",
      ".cbs-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}",
      ".cbs-actions{display:flex;align-items:center;gap:10px}",
      ".cbs-btn{height:28px;padding:0 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-brand,var(--dsw-static-blue-500,#3b82f6));background:var(--dsw-static-blue-500,#3b82f6);color:#fff;font-size:12px;cursor:pointer}",
      ".cbs-btn:hover{opacity:.9}",
      ".cbs-btn:disabled{opacity:.5;cursor:default}",
      ".cbs-btn-ghost{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary)}",
      ".cbs-btn-ghost:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);opacity:1}",
      ".cbs-msg{font-size:12px}",
      ".cbs-msg-ok{color:var(--dsw-static-green-500,#22c55e)}",
      ".cbs-msg-err{color:var(--dsw-alias-state-error-primary)}",
      ".cbs-diag{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}",
      ".cbs-diag-h{padding:6px 10px;background:var(--dsw-alias-bg-layer-2);font-weight:600;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".cbs-diag-row{display:grid;grid-template-columns:150px 1fr auto;gap:8px;padding:7px 10px;border-bottom:1px dashed var(--dsw-alias-border-l1);align-items:center;font-size:12px}",
      ".cbs-diag-row:last-child{border-bottom:none}",
      ".cbs-diag-name{font-weight:600}",
      ".cbs-diag-mono{font-family:Consolas,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
      ".cbs-rates{margin-top:6px;display:flex;flex-direction:column;gap:3px}",
      ".cbs-rate-row{display:flex;gap:6px;align-items:baseline;font-size:11px;line-height:1.5}",
      ".cbs-rate-tag{flex:none;font-family:Consolas,Menlo,monospace;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}",
      ".cbs-rate-free{color:var(--dsw-static-green-500,#22c55e);border:1px solid var(--dsw-static-green-500,#22c55e)}",
      ".cbs-rate-unknown{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));border:1px dashed var(--dsw-alias-border-l1)}",

    ".cbs-rate-promo{color:var(--dsw-static-orange-500,#f59e0b);border:1px solid var(--dsw-static-orange-500,#f59e0b);}",      ".cbs-rate-ids{font-family:Consolas,Menlo,monospace;color:var(--dsw-alias-label-secondary);word-break:break-all}",
      ".cbs-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:9px;font-size:11px;white-space:nowrap}",
      ".cbs-badge-ok{color:var(--dsw-static-green-500,#22c55e);border:1px solid var(--dsw-static-green-500,#22c55e)}",
      ".cbs-badge-warn{color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary)}",
      ".cbs-badge-err{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary)}",
      ".cbs-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px 14px}",
      ".cbs-card-h{font-weight:600;font-size:12px;margin-bottom:10px;color:var(--dsw-alias-label-secondary)}"
    ].join("");
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"codebuddy-indicator\"]") === null) {
      const tag = document.createElement("style");
      tag.setAttribute("data-plugin", "codebuddy-indicator");
      tag.setAttribute("data-plugin-css", "codebuddy-indicator");
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function pillClass(state) {
      if (state === "running") return " cb-run";
      if (state === "ok") return " cb-ok";
      if (state === "failed") return " cb-fail";
      if (state === "fallback") return " cb-fb";
      return "";
    }
    function pillText(state, running) {
      if (state === "running") return "\u27F3 CB" + (running > 1 ? " \u00D7" + running : "");
      if (state === "ok") return "\u2713 CB";
      if (state === "failed") return "\u2717 CB";
      if (state === "fallback") return "\u21A9 CB";
      return "CB";
    }
    function pillTitle(p) {
      const parts = [];
      parts.push(p.name ? ("project: " + p.name) : "project: " + p.cwd);
      if (p.current) { const c = p.current; parts.push("step " + c.stepIndex + " \u2192 " + c.tool + (c.args ? " " + JSON.stringify(c.args) : "")); }
      else if (p.running > 0) parts.push("(starting / thinking)");
      if (p.trail && p.trail.length) parts.push("recent: " + p.trail.slice(-3).map(function (e) { return e.state + " " + e.tool; }).join(" | "));
      if (p.lastStatus) parts.push("last=" + p.lastStatus + (p.lastSessionId ? " " + p.lastSessionId.slice(0, 8) : ""));
      return "codebuddy [" + p.state + (p.running > 0 ? " \u00D7" + p.running : "") + "] " + p.cwd + (parts.length ? "\n" + parts.join("\n") : "");
    }

    function Pill(props) {
      const p = props.p;
      return react.createElement("div", { className: "cb-ind" + pillClass(p.state), title: pillTitle(p), onClick: props.onClick },
        react.createElement("span", { className: "cb-dot" }),
        react.createElement("span", null, react.createElement("b", null, pillText(p.state, p.running))));
    }

    function argText(a) {
      if (a === undefined || a === null) return "";
      try { const j = JSON.stringify(a); return j.length > 140 ? j.slice(0, 137) + "…" : j; } catch (e) { return String(a); }
    }

    function Popup(props) {
      const s = props.s;
      const onClose = props.onClose;
      const rows = [];
      if (s && Array.isArray(s.projects) && s.projects.length) {
        s.projects.forEach(function (p, i) {
          const head = (p.state === "running" ? "\u27F3 " : p.state === "ok" ? "\u2713 " : p.state === "failed" ? "\u2717 " : p.state === "fallback" ? "\u21A9 " : "") + (p.name || p.cwd);
          const badge = "[" + p.state + (p.running > 0 ? " \u00D7" + p.running : "") + "]";
          rows.push(react.createElement("div", { key: "p" + i, className: "cb-pop-proj" },
            react.createElement("div", { className: "cb-pop-proj-head" }, head, " ", react.createElement("span", { className: "cb-pop-mono" }, badge)),
            react.createElement("div", { className: "cb-pop-line cb-pop-mono" }, p.cwd),
            (function () {
              if (p.current) {
                const c = p.current;
                return react.createElement("div", { className: "cb-pop-cur" },
                  react.createElement("div", null, "当前: step " + c.stepIndex + " \u2192 " + c.tool),
                  react.createElement("div", { className: "cb-pop-mono" }, c.args ? argText(c.args) : ""));
              }
              if (p.running > 0) {
                return react.createElement("div", { className: "cb-pop-cur" }, "(starting / thinking…)");
              }
              return null;
            })(),
            (p.trail && p.trail.length) ? react.createElement("div", null,
              react.createElement("div", { className: "cb-pop-line", style: { marginTop: "6px", color: "var(--dsw-alias-label-secondary)" } }, "最近步骤:"),
              p.trail.slice(-6).map(function (e, j) {
                return react.createElement("div", { key: "t" + j, className: "cb-pop-line cb-pop-mono" },
                  "[" + e.state + "] step " + e.stepIndex + " " + e.tool + (e.args ? " " + argText(e.args) : ""));
              })) : null,
            (p.running > 0 && p.updatedAt) ? react.createElement("div", { className: "cb-pop-line", style: { marginTop: "6px", color: (Date.now() - p.updatedAt > 90000 ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-secondary)") } },
              "无活动 " + Math.max(0, Math.round((Date.now() - p.updatedAt) / 1000)) + "s" + (Date.now() - p.updatedAt > 90000 ? "（若长任务请耐心；若疑似卡住可取消重试）" : "")) : null,
            (p.lastStatus) ? react.createElement("div", { className: "cb-pop-line cb-pop-mono", style: { marginTop: "6px" } },
              "last=" + p.lastStatus + (p.lastSessionId ? " " + p.lastSessionId.slice(0, 8) : "")) : null));
        });
      } else {
        rows.push(react.createElement("div", { key: "empty", className: "cb-pop-empty" }, "暂无 codebuddy 活动"));
      }
      const headText = "codebuddy 状态" + (s && s.state ? " · " + s.state + (s.running > 0 ? " (" + s.running + " running)" : "") : "") + (typeof props.mode === "string" ? props.mode : (s && s.presetActive ? " · codebuddy 优先" : " · 普通模式"));
      return react.createElement("div", { className: "cb-pop-overlay", onClick: onClose },
        react.createElement("div", { className: "cb-pop-panel", onClick: function (e) { e.stopPropagation(); } },
          react.createElement("div", { className: "cb-pop-head" },
            react.createElement("span", null, headText),
            react.createElement("button", { className: "cb-pop-close", title: "关闭 (Esc)", onClick: onClose }, "\u2715")),
          react.createElement("div", { className: "cb-pop-body" }, rows)));
    }

    // per-session preset 判定（v1.1.2 起双通道，跨 DSH 版本兼容）：
    //  a) 框架标准 props（DSH Desktop ≥ 0.3.14 / dsh 0.1.2-alpha.5）：sessionId 与
    //     useSessions 选择器钩子由会话作用域槽位框架注入，读
    //     byId[sessionId].projectionValues.agentPreset（alpha.5 起 preset 字段移入投影值）；
    //  b) 旧式注入（更早版本）：inject(sessionId) 收到会话 id + sessions 服务的
    //     list 快照（byId[sessionId].agentPreset，旧 summary 字段）。
    // 两条通道的读取函数同时认新旧两种 summary 形状。都不可用 → UNKNOWN →
    // 回退端点的全局心跳租约（host 半）。
    // UNKNOWN 哨兵必须是稳定原始值（getSnapshot 契约）。
    const PRESET_UNKNOWN = "\u0000unknown";
    const PRESET_CODEBUDDY_FIRST = "codebuddy-first";
    function subscribeNoop() { return function () { }; }
    function presetOfSummary(sum) {
      if (!sum) return PRESET_UNKNOWN;
      if (sum.projectionValues && typeof sum.projectionValues.agentPreset === "string") return sum.projectionValues.agentPreset;
      if (typeof sum.agentPreset === "string") return sum.agentPreset;
      return PRESET_UNKNOWN;
    }
    function presetOfState(state, sessionId) {
      try {
        if (!state || !sessionId || !state.byId) return PRESET_UNKNOWN;
        return presetOfSummary(state.byId[sessionId]);
      } catch (e) { return PRESET_UNKNOWN; }
    }

    function Indicator(props) {
      const p = props || {};
      // 标准属性（新框架）优先；老框架经 inject(sessionId) 提供 injectedSessionId。
      const sessionId = (typeof p.sessionId === "string" && p.sessionId) || (typeof p.injectedSessionId === "string" && p.injectedSessionId) || undefined;
      const useSess = typeof p.useSessions === "function" ? p.useSessions : null;
      const sessionsSvc = p.sessionsSvc;
      const st = react.useState(null);
      const s = st[0];
      const setS = st[1];
      const ot = react.useState(false);
      const open = ot[0];
      const setOpen = ot[1];
      // 本会话的 agent preset（三态：已知 'codebuddy-first' / 已知其他 / UNKNOWN）。
      // 恰好一条钩子通道；useSessions 的有无在同一挂载期内恒定，满足 hooks 规则。
      let myPreset;
      if (useSess) {
        myPreset = useSess(function (state) { return presetOfState(state, sessionId); });
      } else {
        myPreset = react.useSyncExternalStore(
          (sessionsSvc && sessionsSvc.list) ? sessionsSvc.list.subscribe : subscribeNoop,
          function () {
            try {
              if (!sessionsSvc || !sessionsSvc.list) return PRESET_UNKNOWN;
              return presetOfState(sessionsSvc.list.getSnapshot(), sessionId);
            } catch (e) { return PRESET_UNKNOWN; }
          });
      }
      const presetKnown = myPreset !== PRESET_UNKNOWN;
      // 「本会话是否 codebuddy-first」三态判定（null = 未知 → 回退全局租约）。
      // 两条独立通道，**任一肯定即肯定**，只有都不肯定时才让 host 名单做否定：
      //  ① host 名单 presetSessions（权威）：host 实时枚举 agents.list() +
      //     agentPresets.composedPreset() 得到的 codebuddy-first 会话 id；
      //  ② DSH 客户端会话摘要（标准 props / 旧式注入，见文件头注释）。
      // 「任一肯定即肯定」不是冗余而是安全阀：万一两端 sessionId 取法失配
      // （客户端拿不到 id、或 DSH 改了 id 形状），退化成「灯不亮」而不是误判；
      // 若反过来让名单单方面否定，一旦失配就会**永久不亮**——比原缺陷更糟。
      const hostList = (s && Array.isArray(s.presetSessions)) ? s.presetSessions : null;
      const inHostList = !!(hostList && sessionId && hostList.indexOf(sessionId) >= 0);
      const clientSaysYes = presetKnown && myPreset === PRESET_CODEBUDDY_FIRST;
      const iAmCbFirst = (inHostList || clientSaysYes)
        ? true
        : (presetKnown
            ? false                                              // 客户端明确读到别的 preset → 确定不是
            : ((hostList && hostList.length > 0 && sessionId)
                ? false                                          // 名单有内容而我不在其中 → 确定不是
                : null));                                        // 无从判断 → 回退全局租约
      react.useEffect(function () {
        let alive = true;
        let timerId = null;
        const tick = function () {
          fetch("/codebuddy-indicator/status", { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (v) { if (alive) setS(v); })
            .catch(function () { });
        };
        tick();
        timerId = setInterval(tick, 1200);
        return function () {
          alive = false;
          if (timerId !== null) clearInterval(timerId);
        };
      }, []);
      react.useEffect(function () {
        if (!open) return;
        const h = function (e) { if (e.key === "Escape") setOpen(false); };
        window.addEventListener("keydown", h);
        return function () { window.removeEventListener("keydown", h); };
      }, [open]);
      const hasProjects = s && Array.isArray(s.projects) && s.projects.length;
      // 空转「就绪」灯的显示资格：本会话 codebuddy-first；判定不可用时回退全局租约。
      const readyShow = iAmCbFirst === true || (iAmCbFirst === null && !!(s && s.presetActive));
      if (!hasProjects && !readyShow) {
        return null;
      }
      const openDetail = function () { setOpen(true); };
      let light;
      if (hasProjects) {
        light = react.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
          s.projects.map(function (p, i) { return react.createElement(Pill, { key: p.cwd || ("p" + i), p: p, onClick: openDetail }); }));
      } else {
        const state = s ? s.state : "idle";
        let text = "CB 就绪";
        if (state === "running") text = "CB 工作中" + (s && s.running > 1 ? " \u00D7" + s.running : "");
        else if (state === "ok") text = "CB";
        else if (state === "failed") text = "CB 失败";
        else if (state === "fallback") text = "本地回退";
        let detail = "";
        if (s) {
          const parts = [];
          if (s.current) { const c = s.current; parts.push("step " + c.stepIndex + " \u2192 " + c.tool + (c.args ? " " + JSON.stringify(c.args) : "")); }
          else if (s.state === "running") parts.push("(starting / thinking)");
          if (s.trail && s.trail.length) parts.push("recent: " + s.trail.slice(-3).map(function (e) { return e.state + " " + e.tool; }).join(" | "));
          if (s.lastStatus) parts.push("last=" + s.lastStatus + (s.lastSessionId ? " " + s.lastSessionId.slice(0, 8) : ""));
          detail = parts.join(" \u2014 ");
        }
        const title = s ? ("codebuddy state=" + s.state + " running=" + s.running + (detail ? "\n" + detail : "")) : "codebuddy status";
        light = react.createElement("div", { className: "cb-ind" + pillClass(state), title: title, onClick: openDetail },
          react.createElement("span", { className: "cb-dot" }), react.createElement("span", null, text));
      }
      if (!open) return light;
      const modeText = iAmCbFirst === true ? " · 本会话 codebuddy 优先"
        : (iAmCbFirst === false ? " · 普通模式"
          : (s && s.presetActive ? " · codebuddy 优先（其他会话）" : " · 普通模式"));
      return react.createElement(react.Fragment, null,
        light,
        react.createElement(Popup, { s: s, mode: modeText, onClose: function () { setOpen(false); } }));
    }

    // ── v1.3.2：可视化配置界面（settings.section 分区）────────────────────────
    // 数据通道是自家路由 GET/POST /codebuddy-indicator/settings（host 半写入
    // dsh-home/codebuddy-bridge-settings.json；preset/dynamic/MCP 三形态每次调用
    // 现读该文件 → 保存即生效，无需重启）。为什么不用官方自动表单：
    // dsh-config-editor 只列 fiber.entry.id === "include" 的条目，而 preset 经
    // PresetTree 组合挂载、bridge 行不是 include → 桥接插件的 Config 永远进不了
    // 表单投影（0.1.7-rc.1 源码逐行核实）。自绘面板同时能展示诊断信息，这是
    // 自动表单做不到的。

    function SettingsPanel() {
      const vt = react.useState(null); const view = vt[0]; const setView = vt[1];
      const ft = react.useState(null); const form = ft[0]; const setForm = ft[1];
      const mt = react.useState(null); const msg = mt[0]; const setMsg = mt[1];
      const lt = react.useState(false); const loading = lt[0]; const setLoading = lt[1];
      const clearTok = react.useState(false); const wantClear = clearTok[0]; const setWantClear = clearTok[1];

      const adopt = react.useCallback(function (v) {
        setView(v);
        setForm({ preferredBackend: v.preferredBackend, defaultModel: v.defaultModel, endpointOverride: v.endpointOverride, codebuddyEnToken: "" });
      }, []);

      const reload = react.useCallback(function () {
        fetch("/codebuddy-indicator/settings", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
          .then(adopt)
          .catch(function (e) { setMsg({ kind: "err", text: "读取失败：" + e.message }); });
      }, [adopt]);

      react.useEffect(function () { reload(); }, [reload]);

      const setField = function (k) {
        return function (e) { setForm(function (f) { const n = Object.assign({}, f); n[k] = e.target.value; return n }); };
      };

      const save = function () {
        if (!form || loading) return;
        setLoading(true); setMsg(null);
        const body = { preferredBackend: form.preferredBackend, defaultModel: form.defaultModel, endpointOverride: form.endpointOverride };
        if (form.codebuddyEnToken) body.codebuddyEnToken = form.codebuddyEnToken;
        if (wantClear) body.codebuddyEnTokenClear = true;
        fetch("/codebuddy-indicator/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
          .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
          .then(function (res) {
            setLoading(false);
            if (res.code === 200 && res.j && res.j.ok) {
              setWantClear(false);
              if (res.j.settings) adopt(res.j.settings);
              setMsg({ kind: "ok", text: "已保存 ✓ 立即生效（preset / 动态 / MCP 三种形态共享同一份设置）" });
            } else {
              setMsg({ kind: "err", text: "保存失败：" + ((res.j && res.j.error) || ("HTTP " + res.code)) });
            }
          })
          .catch(function (e) { setLoading(false); setMsg({ kind: "err", text: "保存失败：" + e.message }); });
      };

      if (!view || !form) {
        return react.createElement("div", { className: "cbs-root" },
          react.createElement("div", { className: "cbs-h" }, "CodeBuddy 桥接"),
          react.createElement("div", { className: "cbs-sub" }, msg ? msg.text : "加载设置…"));
      }
      const beList = Array.isArray(view.backends) ? view.backends : [];
      const cur = beList.filter(function (b) { return b.id === form.preferredBackend })[0];
      const models = (cur && Array.isArray(cur.models)) ? cur.models : [];
      // v1.5.0：带倍率的候选。优先用 modelOptions（含 label/credits/free）；
      // 旧版后端不返回时退化为纯 id 列表，保证向前兼容。
      const opts = (cur && Array.isArray(cur.modelOptions) && cur.modelOptions.length)
        ? cur.modelOptions
        : models.map(function (m) { return { id: m, label: m, credits: null, baseCredits: null, free: false, hasCredits: false, authorized: null, promotion: null }; });
      // v1.6.0：区分「账号已授权（实测可用）」与「目录里有但本账号未授权」。
      // 未授权的选中必报 400，必须让用户一眼看出，而不是选了才知道。
      const usable = opts.filter(function (o) { return o.authorized !== false; });
      const blocked = opts.filter(function (o) { return o.authorized === false; });
      const freeOnes = usable.filter(function (o) { return o.free; });
      const priced = usable.filter(function (o) { return o.hasCredits && !o.free; });
      const unknown = usable.filter(function (o) { return !o.hasCredits; });
      // v1.6.1：当前**生效中**的限时优惠（Free now / 夜间免费 / 限时免费）。
      // 促销带生效时段，故只列此刻命中的，与 CLI 菜单显示一致。
      const promotion = usable.filter(function (o) { return !!o.promotion; });
      return react.createElement("div", { className: "cbs-root" },
        react.createElement("div", null,
          react.createElement("div", { className: "cbs-h" }, "CodeBuddy 桥接"),
          react.createElement("div", { className: "cbs-sub" }, "CLI 派发偏好（首选后端 / 默认模型 / 端点 / 国际版凭据）。保存后对 codebuddy-first preset、动态插件与 MCP 三种形态即时生效。")),
        react.createElement("div", { className: "cbs-card" },
          react.createElement("div", { className: "cbs-card-h" }, "偏好设置"),
          react.createElement("div", { className: "cbs-grid" },
            react.createElement("label", { className: "cbs-label", htmlFor: "cbs-backend" }, "首选 CLI"),
            react.createElement("div", { className: "cbs-ctl" },
              react.createElement("select", { id: "cbs-backend", className: "cbs-select", value: form.preferredBackend, onChange: setField("preferredBackend") },
                beList.map(function (b) { return react.createElement("option", { key: b.id, value: b.id }, b.label + "（" + b.id + "）"); })),
              cur && cur.needsToken ? react.createElement("div", { className: "cbs-note" }, "国际版 token 被桌面 App 封装不落盘，需在下方「国际版凭据」提供（或在 DSH 配好 workbuddy provider 自动复用）。") : null,
              react.createElement("div", { className: "cbs-note" }, "会话里显式传 backend 参数时仍以参数为准；此处只影响缺省派发。")),
            react.createElement("label", { className: "cbs-label", htmlFor: "cbs-model" }, "默认模型"),
            react.createElement("div", { className: "cbs-ctl" },
              react.createElement("input", { id: "cbs-model", className: "cbs-input", list: "cbs-model-list", value: form.defaultModel, onChange: setField("defaultModel"), placeholder: "留空 = 各 CLI 自身默认", spellCheck: false }),
              react.createElement("datalist", { id: "cbs-model-list" }, usable.slice(0, 60).map(function (o) { return react.createElement("option", { key: o.id, value: o.id, label: o.label }); })),
              react.createElement("div", { className: "cbs-note" }, "候选来自该后端自己的模型目录（CLI 运行时真正加载的 product 描述文件）；标「未授权」的型号本账号无权限，选中会报 400。也可手输任意 CLI 支持的模型 id。"),
              // v1.5.0：倍率一览 —— 让用户能精确判断成本。倍率随 CLI 描述文件实时同步。
              // v1.6.0：只统计「本账号可用」的型号，并把未授权的单独列成一行。
              opts.length ? react.createElement("div", { className: "cbs-rates" },
                freeOnes.length ? react.createElement("div", { className: "cbs-rate-row" },
                  react.createElement("span", { className: "cbs-rate-tag cbs-rate-free" }, "免费 ×" + freeOnes.length),
                  react.createElement("span", { className: "cbs-rate-ids" }, freeOnes.map(function (o) { return o.id; }).join("、")),
                ) : null,
                priced.length ? react.createElement("div", { className: "cbs-rate-row" },
                  react.createElement("span", { className: "cbs-rate-tag" }, "计费"),
                  react.createElement("span", { className: "cbs-rate-ids" }, priced.map(function (o) { return o.label; }).join("、")),
                ) : null,
                unknown.length ? react.createElement("div", { className: "cbs-rate-row" },
                  react.createElement("span", { className: "cbs-rate-tag cbs-rate-unknown" }, "未标倍率"),
                  react.createElement("span", { className: "cbs-rate-ids" }, unknown.map(function (o) { return o.id; }).join("、")),
                ) : null,
                // v1.6.1：与 CLI 菜单里的「Free now / 夜间免费 / 限时免费」对齐。
                promotion.length ? react.createElement("div", { className: "cbs-rate-row" },
                  react.createElement("span", { className: "cbs-rate-tag cbs-rate-promo" }, "限时优惠 ×" + promotion.length),
                  react.createElement("span", { className: "cbs-rate-ids" }, promotion.map(function (o) { return o.id + "（" + o.promotion.label + "）"; }).join("、")),
                ) : null,
                blocked.length ? react.createElement("div", { className: "cbs-rate-row" },
                  react.createElement("span", { className: "cbs-rate-tag cbs-rate-unknown" }, "未授权 ×" + blocked.length),
                  react.createElement("span", { className: "cbs-rate-ids" }, blocked.map(function (o) { return o.id; }).join("、")),
                ) : null,
              ) : null,
              react.createElement("div", { className: "cbs-note" }, "倍率与限时优惠均取自该 CLI 的账号级配置（随账号与时间自动同步）：倍率是 models[].credits，限时优惠是 modelPromotions（如「夜间免费」每晚 23:00–次日 8:00 生效）。倍率为消费系数，x0.00 即免费；未标倍率表示该配置未提供该数据，不代表免费。")),
            react.createElement("label", { className: "cbs-label", htmlFor: "cbs-endpoint" }, "端点覆盖"),
            react.createElement("div", { className: "cbs-ctl" },
              react.createElement("input", { id: "cbs-endpoint", className: "cbs-input", value: form.endpointOverride, onChange: setField("endpointOverride"), placeholder: "留空 = 按登录域自动推导（推荐）", spellCheck: false }),
              react.createElement("div", { className: "cbs-note" }, "仅调试用。留空时端点由 auth 库的登录域推导（见下方诊断），错配会导致 CLI 401。")),
            react.createElement("label", { className: "cbs-label", htmlFor: "cbs-token" }, "国际版凭据"),
            react.createElement("div", { className: "cbs-ctl" },
              react.createElement("input", { id: "cbs-token", className: "cbs-input", type: "password", value: form.codebuddyEnToken, onChange: setField("codebuddyEnToken"), placeholder: view.codebuddyEnToken && view.codebuddyEnToken.set ? ("已保存 " + view.codebuddyEnToken.hint + "，留空保持不变") : "粘贴 workbuddy.ai 的 token（也可不填，见右侧诊断）", spellCheck: false, autoComplete: "off" }),
              react.createElement("label", { className: "cbs-check" },
                react.createElement("input", { type: "checkbox", checked: wantClear, onChange: function (e) { setWantClear(e.target.checked); } }),
                "清除已保存的 token"),
              react.createElement("div", { className: "cbs-note" }, "存储于本机 " + (view.fileName || "codebuddy-bridge-settings.json") + "，页面只显示尾 4 位掩码，明文永不回传浏览器。")),
            react.createElement("div", { className: "cbs-label" }, ""),
            react.createElement("div", { className: "cbs-actions" },
              react.createElement("button", { className: "cbs-btn", type: "button", onClick: save, disabled: loading }, loading ? "保存中…" : "保存"),
              react.createElement("button", { className: "cbs-btn cbs-btn-ghost", type: "button", onClick: function () { setWantClear(false); reload(); } }, "重载"),
              msg ? react.createElement("span", { className: "cbs-msg " + (msg.kind === "ok" ? "cbs-msg-ok" : "cbs-msg-err") }, msg.text) : null))
        ),
        react.createElement("div", { className: "cbs-diag" },
          react.createElement("div", { className: "cbs-diag-h" }, "各后端当前生效配置（诊断）"),
          (Array.isArray(view.diagnostics) ? view.diagnostics : []).map(function (d, i) {
            const meta = beList.filter(function (b) { return b.id === d.backend })[0];
            const badge = d.backend === view.preferredBackend
              ? react.createElement("span", { className: "cbs-badge cbs-badge-ok" }, "首选")
              : null;
            const srcText = d.endpointSource === "override" ? "覆盖" : d.endpointSource === "auth-domain" ? "登录域" : "product";
            const warn = d.mismatch ? react.createElement("span", { className: "cbs-badge cbs-badge-warn", title: d.hint || "" }, "需凭据/可能 401") : null;
            return react.createElement("div", { key: d.backend, className: "cbs-diag-row" },
              react.createElement("div", { className: "cbs-diag-name" }, (meta ? meta.label : d.backend), " ", badge, warn),
              react.createElement("div", null,
                react.createElement("div", { className: "cbs-diag-mono" }, d.endpoint || "—", " (", srcText, ")"),
                react.createElement("div", { className: "cbs-diag-mono" }, "登录域: ", d.authDomain || "未检测到", " ｜ 凭据: ", d.tokenHint),
                d.hint ? react.createElement("div", { className: "cbs-note", style: { color: "var(--dsw-alias-state-warn-primary)" } }, d.hint) : null),
              react.createElement("div", { className: "cbs-diag-mono" }, "模型 ", d.defaultModel));
          }))
      );
    }

    function apply(ctx) {
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["slots"], function (scope) {
        const slots = scope.get("slots");
        if (slots === undefined) return;
        scope.slots.inject("conversation.session.header.utilities", function () {
          // inject 兼容两层：新框架（≥0.3.14）以零参调用本函数、标准 props 由框架
          // 合入（sessionId + useSessions）；旧框架以 sessionId 调用——改名
          // injectedSessionId 避免与标准 props 冲突。sessionsSvc 两代通用（sessions
          // 服务的 list 快照至今保留）。
          return slots.register({ name: "conversation.session.header.utilities", id: "codebuddy-indicator-home", order: 50, inject: function (injectedSessionId) { return { injectedSessionId: injectedSessionId, sessionsSvc: scope.get("sessions") }; } }, function (props) { return react.createElement(Indicator, props); });
        });
        // v1.3.2：可视化配置界面。settings.section 是列表槽（root 级），由
        // dsh-client-ui-settings-general 在 SettingsRoot 的 children 表声明；
        // slots.inject 保证上账后才注册（先于设置界面加载也能挂上）。
        // order=7：general=0、bot-gateway=5、mobile-companion=6 之后。
        // label 用 thunk（locale 切换时 resolveSlotLabel 在读时重算）。
        scope.slots.inject("settings.section", function () {
          return slots.register({
            name: "settings.section",
            id: "codebuddy-bridge-settings",
            order: 7,
            label: function () {
              try { return (String(navigator.language || "").toLowerCase().indexOf("zh") === 0) ? "CodeBuddy 桥接" : "CodeBuddy Bridge"; }
              catch (e) { return "CodeBuddy Bridge"; }
            }
          }, SettingsPanel);
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
