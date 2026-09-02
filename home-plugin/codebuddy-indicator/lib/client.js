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
// 可见性（v1.1.1）：活动灯（项目 pill）全局显示；「CB 就绪」空转灯只在该会话
// 本身处于 codebuddy-first 模式时显示——经 slot inject(sessionId) 拿到本会话
// id，再从客户端 sessions.list 快照读取该会话的 agentPreset（preset id 即目录
// 名 'codebuddy-first'）本地判定。快照/服务不可用时回退到端点的全局
// presetActive（心跳租约，见 host 半）。

window.__ModuleLoader__.load({
  id: "codebuddy-indicator",
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
      ".cb-pop-cur .cb-pop-mono{color:var(--dsw-alias-label-primary)}"
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

    // per-session preset 判定：sessions.list 快照（byId[sessionId].agentPreset）。
    // UNKNOWN 哨兵必须是稳定原始值（useSyncExternalStore 的 getSnapshot 契约）。
    const PRESET_UNKNOWN = "\u0000unknown";
    const PRESET_CODEBUDDY_FIRST = "codebuddy-first";
    function subscribeNoop() { return function () { }; }

    function Indicator(props) {
      const sessionId = props && props.sessionId;
      const sessionsSvc = props && props.sessionsSvc;
      const st = react.useState(null);
      const s = st[0];
      const setS = st[1];
      const ot = react.useState(false);
      const open = ot[0];
      const setOpen = ot[1];
      // 本会话的 agent preset（三态：已知 'codebuddy-first' / 已知其他 / UNKNOWN）
      const myPreset = react.useSyncExternalStore(
        (sessionsSvc && sessionsSvc.list) ? sessionsSvc.list.subscribe : subscribeNoop,
        function () {
          try {
            if (!sessionsSvc || !sessionsSvc.list) return PRESET_UNKNOWN;
            const snap = sessionsSvc.list.getSnapshot();
            const sum = (snap && snap.byId && sessionId) ? snap.byId[sessionId] : undefined;
            return (sum && typeof sum.agentPreset === "string") ? sum.agentPreset : PRESET_UNKNOWN;
          } catch (e) { return PRESET_UNKNOWN; }
        });
      const presetKnown = myPreset !== PRESET_UNKNOWN;
      const iAmCbFirst = presetKnown ? myPreset === PRESET_CODEBUDDY_FIRST : null;
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

    function apply(ctx) {
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["slots"], function (scope) {
        const slots = scope.get("slots");
        if (slots === undefined) return;
        scope.slots.inject("conversation.session.header.utilities", function () {
          return slots.register({ name: "conversation.session.header.utilities", id: "codebuddy-indicator-home", order: 50, inject: function (sessionId) { return { sessionId: sessionId, sessionsSvc: scope.get("sessions") }; } }, function (props) { return react.createElement(Indicator, props); });
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
