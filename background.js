const WORLD = `viewport-lab-${chrome.runtime.id}`;
const BINDING = "__viewportLabSend";
const sessions = new Map();
const queues = new Map();
const ready = chrome.storage.session.get("sessions").then(({ sessions: saved = {} }) => {
  for (const [tabId, session] of Object.entries(saved)) sessions.set(Number(tabId), session);
});
const controllerSource = fetch(chrome.runtime.getURL("controller.js")).then(r => r.text());

function command(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function enqueue(tabId, operation) {
  const next = (queues.get(tabId) || ready).catch(() => {}).then(operation);
  queues.set(tabId, next);
  next.finally(() => {
    if (queues.get(tabId) === next) queues.delete(tabId);
  }).catch(() => {});
  return next;
}

function save() {
  return chrome.storage.session.set({ sessions: Object.fromEntries(sessions) });
}

async function notify(tabId, message) {
  const session = sessions.get(tabId);
  if (!session?.contextId) return;
  const result = await command(tabId, "Runtime.evaluate", {
    contextId: session.contextId,
    expression: `globalThis.__viewportLab?.receive(${JSON.stringify(message)})`
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
}

async function badge(tabId, active, error = "") {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: error ? "!" : active ? "ON" : "" }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: error ? "#dc2626" : "#2563eb" }),
    chrome.action.setTitle({ tabId, title: error || (active ? "Viewport Lab: clicca per ripristinare" : "Viewport Lab: attiva il viewport") })
  ]);
}

async function setSize(tabId, size, requestId = 0) {
  const session = sessions.get(tabId);
  if (!session) return;
  const width = Math.max(Math.min(240, session.availableWidth), Math.min(session.availableWidth, Math.round(Number(size.width))));
  const height = Math.max(Math.min(180, session.availableHeight), Math.min(session.availableHeight, Math.round(Number(size.height))));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  const scale = 1;
  await command(tabId, "Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 0, mobile: false,
    // Keep the interactive view free of a fixed screenshot crop.
    dontSetVisibleSize: true, scale
  });
  Object.assign(session, { width, height, scale });
  await save();
  await notify(tabId, { type: "size", width, height, scale, availableWidth: session.availableWidth, availableHeight: session.availableHeight, requestId });
}

async function enable(tabId) {
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached = true;
    await command(tabId, "Page.enable");
    await command(tabId, "Runtime.enable");
    const { result } = await command(tabId, "Runtime.evaluate", {
      // Chrome's debugging banner can reduce the available tab height.
      expression: "new Promise(resolve => setTimeout(() => resolve({ width: innerWidth, height: innerHeight }), 150))",
      awaitPromise: true, returnByValue: true
    });
    const { width, height } = result.value;
    sessions.set(tabId, {
      width, height, scale: 1, availableWidth: width, availableHeight: height
    });
    await save();
    await command(tabId, "Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
    const { identifier } = await command(tabId, "Page.addScriptToEvaluateOnNewDocument", {
      source: await controllerSource, worldName: WORLD, runImmediately: true
    });
    sessions.get(tabId).scriptId = identifier;
    await save();
    await badge(tabId, true);
  } catch (error) {
    if (attached) await disable(tabId);
    throw error;
  }
}

async function disable(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;
  // Each cleanup is independent: navigation may have invalidated the old context.
  const cleanup = [
    () => notify(tabId, { type: "stop" }),
    () => session.scriptId && command(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier: session.scriptId }),
    () => command(tabId, "Emulation.clearDeviceMetricsOverride"),
    () => command(tabId, "Runtime.removeBinding", { name: BINDING }),
    () => chrome.debugger.detach({ tabId })
  ];
  for (const operation of cleanup) {
    try { await operation(); } catch { /* A closed or detached tab needs no further restoration. */ }
  }
  sessions.delete(tabId);
  await save();
  await badge(tabId, false).catch(() => {});
}

async function reportError(tabId, error) {
  console.error("Viewport Lab:", error);
  const message = /already attached|another debugger/i.test(error.message)
    ? "Viewport Lab: chiudi DevTools o l'altro debugger e riprova."
    : `Viewport Lab: ${error.message}`;
  await badge(tabId, false, message).catch(() => {});
}

function toggle(tab) {
  if (!tab.id) return Promise.resolve();
  return enqueue(tab.id, async () => {
    if (sessions.has(tab.id)) return disable(tab.id);
    if (!/^(https?|file):/i.test(tab.url || "")) {
      throw new Error("apri una normale pagina web. Le pagine interne di Chrome non sono supportate.");
    }
    await enable(tab.id);
  });
}

chrome.action.onClicked.addListener(tab => {
  toggle(tab).catch(error => reportError(tab.id, error));
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Runtime.bindingCalled" || params.name !== BINDING || source.sessionId) return;
  const tabId = source.tabId;
  let message;
  try { message = JSON.parse(params.payload); } catch { return; }
  enqueue(tabId, async () => {
    const session = sessions.get(tabId);
    if (!session) return;
    if (message.type === "ready") {
      session.contextId = params.executionContextId;
      await save();
      await notify(tabId, { type: "size", ...session, requestId: 0 });
    } else if (params.executionContextId !== session.contextId) {
      return;
    } else if (message.type === "ping") {
      await notify(tabId, { type: "pong" });
    } else if (message.type === "stop") {
      await disable(tabId);
    } else if (message.type === "reset") {
      await setSize(tabId, { width: session.availableWidth, height: session.availableHeight }, message.requestId);
    } else if (message.type === "resize") {
      await setSize(tabId, message, message.requestId);
    }
  }).catch(error => {
    // An in-flight drag can reach a context that disappeared during navigation.
    console.warn("Viewport Lab:", error.message);
  });
});

chrome.debugger.onDetach.addListener(({ tabId }) => {
  enqueue(tabId, async () => {
    sessions.delete(tabId);
    await save();
    await badge(tabId, false).catch(() => {});
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
  enqueue(tabId, async () => {
    sessions.delete(tabId);
    await save();
  }).catch(() => {});
});
