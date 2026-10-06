(() => {
  if (window !== window.top || globalThis.__viewportLab) return;

  const abort = new AbortController();
  const listen = (target, name, handler, options = {}) =>
    target.addEventListener(name, handler, { ...options, signal: abort.signal });
  let host;
  let shadow;
  let width = innerWidth;
  let height = innerHeight;
  let availableWidth = innerWidth;
  let availableHeight = innerHeight;
  let scale = 1;
  let requestId = 0;
  let drag;
  let frame;
  let inFlightResize;
  let pendingResize;
  let heartbeat;
  let missedReplies = 0;
  const HEADER_HEIGHT = 40;
  const INSET_ATTRIBUTE = "data-viewport-lab-inset";
  const insetElements = new Map();
  let pageSheet;
  let pageObserver;
  let insetFrame;
  let insetTimer;
  let insetId = 0;

  function updatePageInset() {
    if (!pageSheet) return;
    // Read the site's own styles without accumulating our previous offsets.
    pageSheet.disabled = true;
    try {
      const root = document.documentElement.computedStyleMap();
      const padding = root.get("padding-top").toString();
      const scrollPadding = root.get("scroll-padding-top").toString();
      const rules = [`:root { padding-top:calc(${padding} + ${HEADER_HEIGHT}px)!important;
        scroll-padding-top:calc(${scrollPadding === "auto" ? "0px" : scrollPadding} + ${HEADER_HEIGHT}px)!important; }`];
      const active = new Set();
      const adjustments = [];
      for (const element of document.querySelectorAll("*")) {
        if (element === host || !(element instanceof HTMLElement)) continue;
        const style = element.computedStyleMap();
        const position = style.get("position").toString();
        if (position !== "fixed" && position !== "sticky") continue;
        // Fixed children of transformed containers move with the page already.
        if (position === "fixed" && element.offsetParent) continue;
        const top = style.get("top").toString();
        if (top === "auto") continue;
        adjustments.push({ element, top });
      }
      // Finish style reads before attribute writes invalidate the site's styles.
      for (const { element, top } of adjustments) {
        let record = insetElements.get(element);
        if (!record) {
          record = { id: `qv-${++insetId}`, original: element.getAttribute(INSET_ATTRIBUTE) };
          insetElements.set(element, record);
          element.setAttribute(INSET_ATTRIBUTE, record.id);
        }
        active.add(element);
        rules.push(`[${INSET_ATTRIBUTE}="${record.id}"] { top:calc(${top} + ${HEADER_HEIGHT}px)!important; }`);
      }
      for (const [element, record] of insetElements) {
        if (active.has(element)) continue;
        restoreInsetAttribute(element, record);
        insetElements.delete(element);
      }
      pageSheet.replaceSync(rules.join("\n"));
      if (!document.adoptedStyleSheets.includes(pageSheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];
      }
    } finally { pageSheet.disabled = false; }
  }

  function restoreInsetAttribute(element, record) {
    if (element.getAttribute(INSET_ATTRIBUTE) !== record.id) return;
    if (record.original === null) element.removeAttribute(INSET_ATTRIBUTE);
    else element.setAttribute(INSET_ATTRIBUTE, record.original);
  }

  function schedulePageInset() {
    // Full-page style inspection must stay out of the pointer-move path.
    if (drag) {
      clearTimeout(insetTimer);
      cancelAnimationFrame(insetFrame);
      insetTimer = insetFrame = undefined;
      return;
    }
    if (insetTimer !== undefined || insetFrame !== undefined) return;
    insetTimer = setTimeout(() => {
      insetTimer = undefined;
      insetFrame = requestAnimationFrame(() => {
        insetFrame = undefined;
        if (!drag) updatePageInset();
      });
    }, 120);
  }

  function send(message) {
    try { globalThis.__viewportLabSend(JSON.stringify(message)); }
    catch { destroy(); }
  }

  function destroy() {
    abort.abort();
    clearInterval(heartbeat);
    cancelAnimationFrame(frame);
    cancelAnimationFrame(insetFrame);
    clearTimeout(insetTimer);
    pageObserver?.disconnect();
    if (pageSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== pageSheet);
    for (const [element, record] of insetElements) restoreInsetAttribute(element, record);
    host?.remove();
    delete globalThis.__viewportLab;
  }

  function display() {
    if (!shadow) return;
    shadow.querySelector('[name="width"]').value = width;
    shadow.querySelector('[name="height"]').value = height;
    shadow.querySelector('[name="width"]').min = Math.min(240, availableWidth);
    shadow.querySelector('[name="width"]').max = availableWidth;
    shadow.querySelector('[name="height"]').min = Math.min(180, availableHeight);
    shadow.querySelector('[name="height"]').max = availableHeight;
    shadow.querySelector("output").textContent = scale < 1 ? `${Math.round(scale * 100)}%` : "px";
    shadow.querySelector(".toolbar").style.zoom = 1 / scale;
    shadow.querySelector(".right").style.width = `${12 / scale}px`;
    shadow.querySelector(".bottom").style.height = `${12 / scale}px`;
    shadow.querySelector(".corner").style.width = `${24 / scale}px`;
    shadow.querySelector(".corner").style.height = `${24 / scale}px`;
  }

  function resize(w, h) {
    width = Math.max(Math.min(240, availableWidth), Math.min(availableWidth, Math.round(w)));
    height = Math.max(Math.min(180, availableHeight), Math.min(availableHeight, Math.round(h)));
    pendingResize = { type: "resize", width, height, requestId: ++requestId };
    display();
    scheduleResize();
  }

  function scheduleResize() {
    if (inFlightResize !== undefined || frame !== undefined || !pendingResize) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const message = pendingResize;
      pendingResize = undefined;
      inFlightResize = message.requestId;
      send(message);
    });
  }

  globalThis.__viewportLab = {
    receive(message) {
      missedReplies = 0;
      if (message.type === "stop") return destroy();
      if (message.type !== "size") return;
      // An older reply still releases transport capacity for the latest intent.
      if (message.requestId === inFlightResize) {
        inFlightResize = undefined;
        scheduleResize();
      }
      if (message.requestId < requestId) return;
      ({ width, height, scale, availableWidth, availableHeight } = message);
      display();
    }
  };

  function mount() {
    if (!globalThis.__viewportLab || host) return;
    host = document.createElement("viewport-lab-controls");
    host.setAttribute("popover", "manual");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;pointer-events:none!important;z-index:2147483647!important;color-scheme:dark!important;font:12px/1.4 system-ui,sans-serif!important;";
    shadow = host.attachShadow({ mode: "open" });
    // Constructed stylesheets also work on pages that forbid inline styles.
    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(`
        :host { font: 12px/1.4 system-ui, sans-serif; }
        *, *::before, *::after { box-sizing: border-box; }
        .toolbar { position:fixed; left:0; right:0; top:0; height:40px; display:flex; align-items:center;
          justify-content:center; gap:6px; padding:5px 8px; border-bottom:1px solid #ffffff26;
          background:#131923; color:#e5eaf3; pointer-events:auto; }
        input { width:57px; min-width:0; height:28px; padding:4px; border:1px solid #ffffff20;
          border-radius:6px; background:#ffffff08; color:#f1f5f9; text-align:center;
          font:500 12px system-ui; appearance:textfield; }
        input::-webkit-inner-spin-button, input::-webkit-outer-spin-button { appearance:none; }
        input:focus-visible, button:focus-visible, .handle:focus-visible { outline:2px solid #60a5fa; outline-offset:2px; }
        .times, output { color:#a3b0c3; font-size:11px; }
        button { flex:none; width:28px; height:28px; padding:0; display:grid; place-items:center;
          border:0; border-radius:6px; background:transparent; color:#cbd5e1; cursor:pointer; }
        button:hover { background:#ffffff15; color:white; }
        svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
        .handle { position:fixed; pointer-events:auto; touch-action:none; user-select:none; background:#2563eb12; }
        .handle:hover, .handle:focus-visible { background:#3b82f645; }
        .right { top:40px; right:0; width:12px; height:calc(100% - 40px); cursor:ew-resize; border-right:2px solid #3b82f6; }
        .bottom { bottom:0; left:0; height:12px; width:100%; cursor:ns-resize; border-bottom:2px solid #3b82f6; }
        .right::after, .bottom::after { content:""; position:absolute; background:#60a5fa; border-radius:4px; box-shadow:0 0 0 1px #1e3a8a; }
        .right::after { right:3px; top:calc(50% - 24px); width:4px; height:48px; }
        .bottom::after { bottom:3px; left:calc(50% - 24px); width:48px; height:4px; }
        .corner { right:0; bottom:0; width:24px; height:24px; cursor:nwse-resize;
          border-radius:8px 0 0 0; background:#2563eb; display:grid; place-items:center; color:white; }
        .corner:hover { background:#3b82f6; }
        @media (max-width:420px) { .toolbar { gap:4px; padding:5px; } }
    `);
    shadow.adoptedStyleSheets = [stylesheet];
    // Build nodes directly, without HTML sinks or changes to the site's CSP.
    const element = (tag, attributes = {}, children = []) => {
      const node = ["svg", "path"].includes(tag)
        ? document.createElementNS("http://www.w3.org/2000/svg", tag)
        : document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      node.append(...children);
      return node;
    };
    const icon = (path, box = "0 0 20 20") => element("svg", { viewBox: box, "aria-hidden": "true" }, [element("path", { d: path })]);
    shadow.append(
      element("div", { class: "handle right", tabindex: "0", role: "separator", "aria-label": "Ridimensiona larghezza", "aria-orientation": "vertical", "data-axis": "width" }),
      element("div", { class: "handle bottom", tabindex: "0", role: "separator", "aria-label": "Ridimensiona altezza", "aria-orientation": "horizontal", "data-axis": "height" }),
      element("div", { class: "handle corner", tabindex: "0", role: "button", "aria-label": "Ridimensiona larghezza e altezza", "data-axis": "both" }, [icon("m5 11 6-6m-2 7 3-3", "0 0 16 16")]),
      element("div", { class: "toolbar", role: "region", "aria-label": "Viewport Lab" }, [
        element("input", { name: "width", type: "number", step: "1", "aria-label": "Larghezza viewport", title: "Larghezza in pixel" }),
        element("span", { class: "times", "aria-hidden": "true" }, ["×"]),
        element("input", { name: "height", type: "number", step: "1", "aria-label": "Altezza viewport", title: "Altezza in pixel" }),
        element("output", { title: "Scala di visualizzazione. Le dimensioni del viewport restano quelle impostate." }, ["px"]),
        element("button", { class: "reset", title: "Ripristina dimensioni iniziali", "aria-label": "Ripristina dimensioni iniziali" }, [icon("M4 8a6 6 0 1 1 0 5M4 3v5h5")]),
        element("button", { class: "close", title: "Chiudi Viewport Lab (Esc)", "aria-label": "Chiudi Viewport Lab" }, [icon("m5 5 10 10M15 5 5 15")])
      ])
    );
    document.documentElement.append(host);
    host.showPopover();
    pageSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];
    updatePageInset();
    pageObserver = new MutationObserver(schedulePageInset);
    pageObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
    listen(window, "resize", schedulePageInset);
    display();

    listen(shadow.querySelector(".close"), "click", () => send({ type: "stop" }));
    listen(shadow.querySelector(".reset"), "click", () => {
      pendingResize = undefined;
      cancelAnimationFrame(frame);
      frame = undefined;
      send({ type: "reset", requestId: ++requestId });
    });
    for (const input of shadow.querySelectorAll("input")) {
      const commit = () => {
        const value = input.valueAsNumber;
        if (Number.isFinite(value)) resize(input.name === "width" ? value : width, input.name === "height" ? value : height);
        else display();
      };
      listen(input, "change", commit);
      listen(input, "keydown", event => {
        if (event.key === "Enter") { commit(); input.blur(); }
        event.stopPropagation();
      });
    }

    for (const handle of shadow.querySelectorAll(".handle")) {
      listen(handle, "pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        drag = { axis: handle.dataset.axis, x: event.screenX, y: event.screenY, width, height, scale };
        schedulePageInset();
        handle.setPointerCapture(event.pointerId);
      });
      listen(handle, "pointermove", event => {
        if (!drag) return;
        event.preventDefault();
        event.stopPropagation();
        resize(
          drag.axis === "height" ? drag.width : drag.width + (event.screenX - drag.x) / drag.scale,
          drag.axis === "width" ? drag.height : drag.height + (event.screenY - drag.y) / drag.scale
        );
      });
      const finish = () => {
        if (!drag) return;
        drag = undefined;
        schedulePageInset();
      };
      listen(handle, "pointerup", finish);
      listen(handle, "pointercancel", finish);
      listen(handle, "lostpointercapture", finish);
      listen(handle, "keydown", event => {
        const step = event.shiftKey ? 10 : 1;
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        resize(
          width + (handle.dataset.axis !== "height" ? ({ ArrowLeft: -step, ArrowRight: step }[event.key] || 0) : 0),
          height + (handle.dataset.axis !== "width" ? ({ ArrowUp: -step, ArrowDown: step }[event.key] || 0) : 0)
        );
      });
    }
    listen(document, "keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        send({ type: "stop" });
      }
    }, { capture: true });
    listen(window, "pageshow", event => {
      if (event.persisted) send({ type: "ready" });
    });
    heartbeat = setInterval(() => {
      // When Chrome cancels debugging, the binding stops responding.
      // Count actual checks so a background tab or a sleeping computer is safe.
      if (document.hidden) { missedReplies = 0; return; }
      if (++missedReplies > 5) return destroy();
      send({ type: "ping" });
    }, 1000);
    send({ type: "ready" });
  }

  if (document.documentElement) mount();
  else listen(document, "DOMContentLoaded", mount, { once: true });
})();
