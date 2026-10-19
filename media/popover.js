// Runs inside the popover webview. The extension owns all state; this script
// renders it and reports user input back with postMessage.
(function () {
  const vscode = acquireVsCodeApi();
  const md = window.markdownit({ html: false, linkify: true, breaks: false });
  const $ = (id) => document.getElementById(id);
  const input = $("q");
  const turnsEl = $("turns");

  let state = { turns: [], busy: false, model: "", where: "" };

  const post = (msg) => vscode.postMessage(msg);

  // ---------------------------------------------------------------- render

  function renderTurn(t, i) {
    const el = document.createElement("div");
    el.className = "turn";
    el.dataset.index = String(i);
    const q = document.createElement("div");
    q.className = "q";
    q.textContent = t.display;
    const a = document.createElement("div");
    a.className = "a";
    const meta = document.createElement("div");
    meta.className = "meta";
    el.append(q, a, meta);
    fillTurn(el, t);
    return el;
  }

  function fillTurn(el, t) {
    const a = el.querySelector(".a");
    const meta = el.querySelector(".meta");
    if (t.status === "pending") {
      a.innerHTML = '<span class="thinking">Thinking</span>';
    } else {
      a.innerHTML = t.answer ? md.render(t.answer) : "";
      if (t.status === "streaming") {
        const last = a.lastElementChild || a;
        last.classList.add("caret");
      } else if (t.status === "error") {
        const e = document.createElement("div");
        e.className = "error";
        e.textContent = "⚠ " + (t.error || "Something went wrong.");
        a.append(e);
      } else if (t.status === "stopped") {
        const s = document.createElement("div");
        s.className = "stopped";
        s.textContent = "(stopped)";
        a.append(s);
      }
    }
    meta.textContent = "";
    if (t.status === "done" || t.status === "stopped") {
      const label = document.createElement("span");
      label.textContent = t.durationMs ? `${t.model} · ${(t.durationMs / 1000).toFixed(1)}s` : t.model;
      const copy = document.createElement("button");
      copy.className = "copy";
      copy.title = "Copy answer";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => post({ t: "copy", index: Number(el.dataset.index) }));
      meta.append(label, copy);
    }
  }

  function renderHeader() {
    $("model").textContent = state.model + " ▾";
    $("height").textContent = "↕ " + (state.height || "Auto") + " ▾";
    $("where").textContent = state.where;
    $("stop").hidden = !state.busy;
  }

  function renderAll() {
    renderHeader();
    turnsEl.textContent = "";
    state.turns.forEach((t, i) => turnsEl.append(renderTurn(t, i)));
    scrollToBottom(true);
    reportSize();
  }

  function nearBottom() {
    return turnsEl.scrollHeight - turnsEl.scrollTop - turnsEl.clientHeight < 40;
  }
  function scrollToBottom(force) {
    if (force || nearBottom()) turnsEl.scrollTop = turnsEl.scrollHeight;
  }

  // The extension sizes the inset in editor lines, so report how tall the
  // content wants to be next to how tall the frame currently is.
  function reportSize() {
    const header = document.querySelector("header").offsetHeight;
    const footer = document.querySelector("footer").offsetHeight;
    const content = header + footer + (state.turns.length ? turnsEl.scrollHeight : 0) + 6;
    post({ t: "size", contentPx: content, viewportPx: window.innerHeight });
  }

  function autosize() {
    input.style.height = "auto";
    if (input.scrollHeight > 0) input.style.height = input.scrollHeight + 2 + "px";
  }

  // ----------------------------------------------------------------- focus

  // Keyboard focus = this frame has focus AND the input is its active element.
  let lastFocus = null;
  function reportFocus() {
    const f = document.hasFocus() && document.activeElement === input;
    if (f) wantFocus = false; // got it: stop any retry loop so a later click elsewhere sticks
    if (f !== lastFocus) {
      lastFocus = f;
      post({ t: "focus", focused: f });
    }
  }

  // A new webview has no focus, and focus() fails until the frame is shown.
  // Keep asking for a moment; keys that arrive first are redirected below.
  let wantFocus = false;
  let holdUntil = 0;
  // hold: after a rebuild the editor takes focus back a moment later, so keep it briefly.
  function grabFocus(hold) {
    wantFocus = true;
    if (hold) holdUntil = Date.now() + 800;
    const start = Date.now();
    // Stop as soon as the input is the active element: carrying on would pull
    // focus back after the user clicks into the code.
    const tick = () => {
      if (!wantFocus) return reportFocus();
      if (document.activeElement === input && (document.hasFocus() || Date.now() - start > 200)) {
        wantFocus = false;
        return reportFocus();
      }
      try { window.focus(); } catch {}
      input.focus();
      if (Date.now() - start < 1500) setTimeout(tick, 30);
      else {
        post({ t: "debug", text: `focus gave up: hasFocus=${document.hasFocus()} active=${document.activeElement && document.activeElement.tagName} visibility=${document.visibilityState}` });
        reportFocus();
      }
    };
    tick();
  }

  // Focus can't move inside a hidden page (window in the background); finish
  // the job when it becomes visible.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wantFocus) grabFocus();
  });

  input.addEventListener("focus", reportFocus);
  const onBlur = () => setTimeout(() => {
    if (Date.now() < holdUntil && !(document.hasFocus() && document.activeElement === input)) grabFocus();
    else reportFocus();
  }, 0);
  input.addEventListener("blur", onBlur);
  window.addEventListener("focus", () => setTimeout(reportFocus, 0));
  window.addEventListener("blur", onBlur);

  // The inset is as wide as the editor's scrollable content, which can run past
  // the visible editor. Measure what's actually visible and fit the card to it.
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;left:0;top:0;width:100%;height:1px;pointer-events:none;visibility:hidden";
  document.body.append(probe);
  new IntersectionObserver((entries) => {
    const r = entries[entries.length - 1];
    if (r && r.intersectionRect.width > 120) {
      document.documentElement.style.setProperty("--pop-visible-width", Math.floor(r.intersectionRect.width) + "px");
    }
  }, { threshold: Array.from({ length: 21 }, (_, i) => i / 20) }).observe(probe);

  // ---------------------------------------------------------------- events

  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.t) {
      case "init":
        state = m.state;
        document.documentElement.style.setProperty("--pop-font-size", m.style.fontSize + "px");
        if (m.style.fontFamily) document.documentElement.style.setProperty("--pop-font-family", m.style.fontFamily);
        input.value = (input.value || "") + (m.draft || "");
        autosize();
        renderAll();
        if (m.focus) grabFocus(m.rebuilt);
        if (input.value) post({ t: "draft", text: input.value });
        break;
      case "turn": {
        state.turns[m.index] = m.turn;
        let el = turnsEl.querySelector(`.turn[data-index="${m.index}"]`);
        if (!el) turnsEl.append(renderTurn(m.turn, m.index));
        else fillTurn(el, m.turn);
        scrollToBottom(false);
        reportSize();
        break;
      }
      case "header":
        state.busy = m.busy;
        state.model = m.model;
        state.where = m.where;
        state.height = m.height;
        renderHeader();
        break;
      case "focus":
        grabFocus();
        break;
      case "draft":
        input.value += m.text;
        autosize();
        post({ t: "draft", text: input.value });
        break;
      case "rects": {
        const r = (el) => { if (!el || el.hidden) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
        post({ t: "rects", id: m.id, rects: { close: r($("close")), stop: r($("stop")), model: r($("model")), height: r($("height")), input: r(input), copy: r(document.querySelector(".copy")) } });
        break;
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      post({ t: "close" });
      return;
    }
    // Printable keys typed before the input had focus: move focus first so the
    // character lands in the input.
    if (e.target !== input && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) input.focus();
  }, true);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      post({ t: "ask", text: input.value });
      input.value = "";
      autosize();
      post({ t: "draft", text: "" });
    }
  });

  input.addEventListener("input", () => {
    autosize();
    post({ t: "draft", text: input.value });
  });

  document.addEventListener("mousedown", () => { holdUntil = 0; }, true);
  $("close").addEventListener("click", () => post({ t: "close" }));
  $("stop").addEventListener("click", () => post({ t: "stop" }));
  $("model").addEventListener("click", () => post({ t: "model" }));
  $("height").addEventListener("click", () => post({ t: "height" }));

  // Open links in the browser instead of inside the webview.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    post({ t: "link", href: a.getAttribute("href") });
  });

  new ResizeObserver(() => reportSize()).observe(document.body);
  post({ t: "ready" });
})();
