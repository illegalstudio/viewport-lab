import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";

// Keep browser downloads and temporary profiles inside this project.
process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
const { chromium } = await import("playwright");
let context, worker, server, profile, url, nativeWindow;
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Responsive fixture</title><style>
*{box-sizing:border-box}body{margin:0;background:#eef2f8;font:16px system-ui;color:#17243c}
header{padding:80px 40px 32px;background:#17243c;color:white}h1{font-size:42px;margin:0 0 12px}
main{padding:32px 40px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
article{padding:24px;border:1px solid #ccd6e5;border-radius:16px;background:white}
.units{width:50vw;height:10vh;background:#2563eb}input{padding:8px}
@media(max-width:600px){main{grid-template-columns:1fr}h1{font-size:30px}}
footer{height:1000px}aside{position:fixed;right:16px;bottom:16px}
</style></head><body><header><h1>Responsive, in real time.</h1><p>The same page. A new viewport.</p>
<input id="state" placeholder="Page state stays here"></header><main>
<article>One card</article><article>Two cards</article><article>Three cards</article>
</main><div class="units"></div><button id="click">Interact</button><a href="#end" id="jump">Jump to bottom</a><footer id="end"><input id="lower-state" placeholder="Field below"></footer><aside id="fixed">Fixed</aside></body></html>`;

before(async () => {
  const style = fixture.match(/<style>([\s\S]*?)<\/style>/)[1] + ".responsive-top{position:fixed;top:0;left:0}@media(max-width:800px){.responsive-top{top:12px}}";
  server = createServer((request, response) => {
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'");
    if (request.url === "/fixture.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(style);
      return;
    }
    if (request.url === "/paint.css") {
      response.setHeader("Content-Type", "text/css");
      response.end("body{margin:0}header{height:400px;background:rgb(255,0,0)}main{height:1800px;padding-top:500px;background:rgb(0,0,255)}");
      return;
    }
    if (request.url === "/header.css") {
      response.setHeader("Content-Type", "text/css");
      response.end("html{padding-top:6px;scroll-padding-top:3px}body{margin:0}.topbar{position:fixed;top:0;left:0;height:28px}#start{height:60px}#sticky{position:sticky;top:10px;height:30px}footer{height:1800px}#fixed-bottom{position:fixed;bottom:0;right:0}");
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/header") {
      response.end('<!doctype html><html><head><title>Fixed header fixture</title><link rel="stylesheet" href="/header.css"></head><body><button id="fixed-top" class="topbar">Site header</button><div id="start">Page start</div><nav id="sticky">Sticky header</nav><footer></footer><aside id="fixed-bottom">Bottom controls</aside></body></html>');
      return;
    }
    if (request.url === "/large") {
      response.end(fixture.replace(/<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="/fixture.css">')
        .replace("</body>", '<button id="responsive-top" class="responsive-top">Responsive header</button><section>' + "<span>Dense page content </span>".repeat(5000) + "</section></body>"));
      return;
    }
    response.end(request.url === "/paint"
      ? '<!doctype html><html><head><title>Scroll paint fixture</title><link rel="stylesheet" href="/paint.css"></head><body><header></header><main><input id="focus" aria-label="Campo fuori vista"></main></body></html>'
      : fixture.replace(/<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="/fixture.css">'));
  });
  await new Promise(r => server.listen(0, "0.0.0.0", r));
  url = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(resolve(".test-profile-"));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.VIEWPORT_LAB_BROWSER || undefined,
    channel: "chromium", headless: true, viewport: null,
    // Hide Chrome's native debug banner in automation so it cannot change the
    // available height while assertions run. The installed extension shows it.
    args: ["--window-size=1200,887", "--silent-debugger-extension-api", `--disable-extensions-except=${resolve(".")}`, `--load-extension=${resolve(".")}`]
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  context.setDefaultTimeout(5000);
  const initialPage = context.pages()[0];
  const protocol = await context.newCDPSession(initialPage);
  try {
    const { windowId, bounds } = await protocol.send("Browser.getWindowForTarget");
    const { cssVisualViewport } = await protocol.send("Page.getLayoutMetrics");
    // Chrome and Brave have different toolbar heights. Establish the same
    // native content size before activating the extension, without emulation.
    if (cssVisualViewport.clientWidth !== 1200 || cssVisualViewport.clientHeight !== 800) {
      await protocol.send("Browser.setWindowBounds", { windowId, bounds: {
        width: bounds.width + 1200 - cssVisualViewport.clientWidth,
        height: bounds.height + 800 - cssVisualViewport.clientHeight
      } });
    }
    await initialPage.waitForFunction(() => innerWidth === 1200 && innerHeight === 800);
    nativeWindow = (await protocol.send("Browser.getWindowForTarget")).bounds;
  } finally { await protocol.detach(); }
  context.on("console", message => {
    if (["error", "warning"].includes(message.type())) console.error(message.text());
  });
});

after(async () => {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  if (server) await new Promise(r => server.close(r));
});

async function open(path = "/") {
  const page = await context.newPage();
  const target = url + path;
  await page.goto(target);
  const tabId = await worker.evaluate(async target => {
    const tabs = await chrome.tabs.query({});
    // Debugger targets expose URLs without requesting access to every host.
    const targets = await chrome.debugger.getTargets();
    return targets.find(t => t.url === target && tabs.some(tab => tab.id === t.tabId))?.tabId;
  }, target);
  assert.ok(tabId);
  await worker.evaluate(({ id, url }) => toggle({ id, url }), { id: tabId, url: target });
  await page.locator("viewport-lab-controls .right").waitFor();
  return { page, tabId };
}

async function dimensions(page) {
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight, outerWidth, outerHeight }));
}

async function controllerEvaluate(tabId, expression) {
  return worker.evaluate(async ({ tabId, expression }) => {
    const { result, exceptionDetails } = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      contextId: sessions.get(tabId).contextId, expression, returnByValue: true
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  }, { tabId, expression });
}

async function windowBounds(page) {
  const protocol = await context.newCDPSession(page);
  try { return (await protocol.send("Browser.getWindowForTarget")).bounds; }
  finally { await protocol.detach(); }
}

async function waitSize(page, width, height) {
  try {
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, { width, height });
  } catch (error) {
    console.error("Expected", width, height, "actual", await dimensions(page));
    throw error;
  }
}

async function size(page, width, height) {
  const w = page.getByRole("spinbutton", { name: "Larghezza viewport" });
  const h = page.getByRole("spinbutton", { name: "Altezza viewport" });
  const expectedWidth = Math.max(Number(await w.getAttribute("min")), Math.min(Number(await w.getAttribute("max")), width));
  const expectedHeight = Math.max(Number(await h.getAttribute("min")), Math.min(Number(await h.getAttribute("max")), height));
  await w.fill(String(width));
  await w.press("Enter");
  await page.waitForFunction(width => innerWidth === width, expectedWidth);
  await h.fill(String(height));
  await h.press("Enter");
  await waitSize(page, expectedWidth, expectedHeight);
}

async function drag(page, selector, dx, dy) {
  const box = await page.locator(selector).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

async function clickPageElement(page, selector, scale = 1) {
  const point = await page.locator(selector).evaluate(element => {
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  // The extension scales rendering outside Playwright's viewport settings.
  // Native pointer coordinates must follow that scale, as a real mouse does.
  await page.mouse.click(point.x * scale, point.y * scale);
}

async function screenshot(tabId, name) {
  if (!process.env.VIEWPORT_LAB_SCREENSHOTS) return;
  // Capture through the extension's session. Playwright's screenshot helper
  // temporarily changes device metrics through a second debugger session.
  const { data } = await worker.evaluate(id => chrome.debugger.sendCommand({ tabId: id }, "Page.captureScreenshot", {
    format: "png", captureBeyondViewport: false
  }), tabId);
  await mkdir("test-results", { recursive: true });
  await writeFile(`test-results/${name}.png`, Buffer.from(data, "base64"));
}

test("handles resize the real viewport, including media queries and viewport units, without reloading or resizing the window", async () => {
  const { page, tabId } = await open();
  try {
    await page.locator("#state").fill("still here");
    await drag(page, ".right", -300, 0);
    await waitSize(page, 900, 800);
    await drag(page, ".bottom", 0, -250);
    await waitSize(page, 900, 550);
    await drag(page, ".corner", -400, -150);
    await waitSize(page, 500, 400);
    assert.equal(await page.evaluate(() => matchMedia("(max-width: 600px)").matches), true);
    assert.deepEqual(await page.locator(".units").evaluate(e => [e.offsetWidth, e.offsetHeight]), [250, 40]);
    assert.equal(await page.locator("#state").inputValue(), "still here");
    await screenshot(tabId, "mobile");
    assert.deepEqual(await windowBounds(page), nativeWindow);
    // Captured pointers must also work outside the smaller viewport when expanding.
    await drag(page, ".right", 350, 0);
    await waitSize(page, 850, 400);
    assert.equal(await page.evaluate(() => matchMedia("(max-width: 600px)").matches), false);
    await page.getByRole("button", { name: "Ripristina dimensioni iniziali" }).click();
    await waitSize(page, 1200, 800);
    await worker.evaluate(id => toggle({ id }), tabId);
    await page.locator("viewport-lab-controls").waitFor({ state: "detached" });
    await waitSize(page, 1200, 800);
  } finally { await page.close(); }
});

test("typed values, dragging and keyboard resizing cannot exceed the native tab dimensions", async () => {
  const { page, tabId } = await open();
  try {
    await size(page, 1920, 1080);
    await waitSize(page, 1200, 800);
    assert.equal(await page.getByRole("spinbutton", { name: "Larghezza viewport" }).inputValue(), "1200");
    assert.equal(await page.getByRole("spinbutton", { name: "Altezza viewport" }).inputValue(), "800");
    assert.equal(await page.locator("viewport-lab-controls output").textContent(), "px");
    await size(page, 500, 400);
    await drag(page, ".corner", 1600, 1000);
    await waitSize(page, 1200, 800);
    await page.getByRole("separator", { name: "Ridimensiona larghezza" }).press("Shift+ArrowRight");
    await page.getByRole("separator", { name: "Ridimensiona altezza" }).press("Shift+ArrowDown");
    await waitSize(page, 1200, 800);
    // Check the backend limit independently of the controls' clamping.
    await worker.evaluate(id => setSize(id, { width: 9000, height: 9000 }), tabId);
    await waitSize(page, 1200, 800);
    assert.deepEqual(await windowBounds(page), nativeWindow);
    await screenshot(tabId, "desktop");
    await page.keyboard.press("Escape");
    await page.locator("viewport-lab-controls").waitFor({ state: "detached" });
    await waitSize(page, 1200, 800);
  } finally { await page.close(); }
});

test("the fixed strip reserves page space, keeps fixed and sticky headers below it, and restores site styles", async () => {
  const { page } = await open("/header");
  try {
    const toolbar = page.locator("viewport-lab-controls .toolbar");
    assert.equal((await toolbar.textContent()).includes("Viewport Lab"), false);
    assert.equal(await page.getByRole("button", { name: "Sposta barra" }).count(), 0);
    await size(page, 500, 400);
    const rect = await toolbar.boundingBox();
    assert.equal(rect.x, 0);
    assert.equal(rect.y, 0);
    assert.equal(rect.width, 500);
    assert.equal(rect.height, 40);
    assert.equal(await page.locator("#start").evaluate(e => e.getBoundingClientRect().top), 46);
    assert.equal(await page.locator("#fixed-top").evaluate(e => e.getBoundingClientRect().top), 40);
    assert.equal(await page.locator("#fixed-bottom").evaluate(e => e.getBoundingClientRect().bottom), 400);
    await page.locator("#fixed-top").click();
    await page.evaluate(() => scrollTo(0, 200));
    await page.waitForFunction(() => document.querySelector("#sticky").getBoundingClientRect().top === 50);
    assert.equal((await toolbar.boundingBox()).y, 0);
    assert.equal(await page.locator("#fixed-top").evaluate(e => e.getBoundingClientRect().top), 40);
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "dynamic-fixed";
      button.className = "topbar";
      button.textContent = "Dynamic header";
      document.body.append(button);
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("body { color: rgb(1, 2, 3); }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    await page.waitForFunction(() => document.querySelector("#dynamic-fixed").getBoundingClientRect().top === 40);
    await size(page, 240, 180);
    assert.equal((await toolbar.boundingBox()).width, 240);
    assert.equal(await page.locator("#fixed-top").evaluate(e => e.getBoundingClientRect().top), 40);
    await page.getByRole("button", { name: "Chiudi Viewport Lab", exact: true }).click();
    await waitSize(page, 1200, 800);
    await page.evaluate(() => scrollTo(0, 0));
    assert.equal(await page.locator("#start").evaluate(e => e.getBoundingClientRect().top), 6);
    assert.equal(await page.locator("#fixed-top").evaluate(e => e.getBoundingClientRect().top), 0);
    assert.equal(await page.locator("#dynamic-fixed").evaluate(e => e.getBoundingClientRect().top), 0);
    assert.equal(await page.locator("#sticky").evaluate(e => getComputedStyle(e).top), "10px");
    assert.equal(await page.locator("[data-viewport-lab-inset]").count(), 0);
    assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 1);
    assert.equal(await page.locator("body").evaluate(e => getComputedStyle(e).color), "rgb(1, 2, 3)");
  } finally { await page.close(); }
});

test("dragging a dense page avoids full-page style scans until release and updates responsive headers afterward", async () => {
  const { page, tabId } = await open("/large");
  try {
    await page.waitForFunction(() => document.querySelector("#responsive-top").getBoundingClientRect().top === 40);
    await controllerEvaluate(tabId, `(() => {
      globalThis.__insetScans = 0;
      const select = document.querySelectorAll;
      document.querySelectorAll = function(selector) {
        if (selector === "*") ++__insetScans;
        return select.call(this, selector);
      };
    })()`);
    const box = await page.locator("viewport-lab-controls .right").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 500, box.y + box.height / 2, { steps: 30 });
    const duringDrag = await controllerEvaluate(tabId, "__insetScans");
    await page.mouse.up();
    await waitSize(page, 700, 800);
    assert.equal(duringDrag, 0, "Full-page header scans must stay out of the drag path");
    await page.waitForFunction(() => document.querySelector("#responsive-top").getBoundingClientRect().top === 52);
    assert.ok(await controllerEvaluate(tabId, "__insetScans") <= 2, "Header updates should be batched after dragging");
    assert.deepEqual(await windowBounds(page), nativeWindow);
  } finally { await page.close(); }
});

test("slow debugger replies collapse pending resize requests to the final dimensions", async () => {
  const { page, tabId } = await open();
  try {
    await size(page, 500, 400);
    await worker.evaluate(id => enqueue(id, () => {}), tabId);
    await worker.evaluate(() => {
      globalThis.__originalCommand = chrome.debugger.sendCommand;
      globalThis.__holdMetrics = () => {
        globalThis.__metricCalls = 0;
        let started;
        globalThis.__metricStarted = new Promise(resolve => { started = resolve; });
        const gate = new Promise(resolve => { globalThis.__releaseMetric = resolve; });
        chrome.debugger.sendCommand = async (...args) => {
          if (args[1] === "Emulation.setDeviceMetricsOverride" && ++__metricCalls === 1) {
            started();
            await gate;
          }
          return __originalCommand(...args);
        };
      };
      __holdMetrics();
    });
    await page.locator("viewport-lab-controls .right").evaluate(handle => {
      handle.addEventListener("pointerdown", event => {
        globalThis.__dragOrigin = { x: event.screenX, y: event.screenY, pointerId: event.pointerId };
      }, { once: true });
    });
    const box = await page.locator("viewport-lab-controls .right").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.evaluate(async () => {
      const handle = document.querySelector("viewport-lab-controls").shadowRoot.querySelector(".right");
      for (let step = 1; step <= 12; step++) {
        handle.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true, buttons: 1, pointerId: __dragOrigin.pointerId,
          screenX: __dragOrigin.x + step * 10, screenY: __dragOrigin.y
        }));
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    });
    await page.mouse.up();
    await worker.evaluate(() => __releaseMetric());
    await waitSize(page, 620, 400);
    await worker.evaluate(id => enqueue(id, () => {}), tabId);
    assert.equal(await worker.evaluate(() => __metricCalls), 2, "Only the in-flight and latest resize should reach the debugger");
    assert.equal(await page.getByRole("spinbutton", { name: "Larghezza viewport" }).inputValue(), "620");
    // Reset must discard pending drag/key intentions even before an old reply.
    await worker.evaluate(() => __holdMetrics());
    const right = page.getByRole("separator", { name: "Ridimensiona larghezza" });
    await right.press("Shift+ArrowLeft");
    await worker.evaluate(() => __metricStarted);
    for (let step = 0; step < 5; step++) await right.press("Shift+ArrowLeft");
    await page.getByRole("button", { name: "Ripristina dimensioni iniziali" }).press("Enter");
    await worker.evaluate(() => __releaseMetric());
    await waitSize(page, 1200, 800);
    await worker.evaluate(id => enqueue(id, () => {}), tabId);
    assert.equal(await worker.evaluate(() => __metricCalls), 2);
    assert.equal(await page.getByRole("spinbutton", { name: "Larghezza viewport" }).inputValue(), "1200");
  } finally {
    await worker.evaluate(() => {
      globalThis.__releaseMetric?.();
      if (globalThis.__originalCommand) chrome.debugger.sendCommand = __originalCommand;
    });
    await page.close();
  }
});

test("reloads and cross-origin navigation preserve dimensions and reinstall the handles", async () => {
  const { page } = await open();
  try {
    await size(page, 390, 700);
    await page.reload();
    await page.locator("viewport-lab-controls .right").waitFor();
    await waitSize(page, 390, 700);
    await page.goto(url.replace("127.0.0.1", "localhost") + "/next");
    await page.locator("viewport-lab-controls .right").waitFor();
    await waitSize(page, 390, 700);
    await page.getByRole("button", { name: "Chiudi Viewport Lab", exact: true }).click();
    await page.locator("viewport-lab-controls").waitFor({ state: "detached" });
    await waitSize(page, 1200, 800);
    await page.reload();
    assert.equal(await page.locator("viewport-lab-controls").count(), 0);
  } finally { await page.close(); }
});

test("keyboard resizing, minimum sizes and independent tabs", async () => {
  const { page } = await open();
  const other = await context.newPage();
  try {
    await other.goto(url + "/other");
    await size(page, 240, 180);
    const right = page.getByRole("separator", { name: "Ridimensiona larghezza" });
    await right.focus();
    await right.press("ArrowLeft");
    await waitSize(page, 240, 180);
    await right.press("Shift+ArrowRight");
    await waitSize(page, 250, 180);
    await page.evaluate(() => scrollTo(0, 300));
    assert.equal(await page.locator(".bottom").evaluate(e => Math.round(e.getBoundingClientRect().bottom)), 180);
    assert.equal(await other.locator("viewport-lab-controls").count(), 0);
    assert.equal((await dimensions(other)).width, 1200);
    await page.keyboard.press("Escape");
    await page.locator("viewport-lab-controls").waitFor({ state: "detached" });
  } finally { await page.close(); await other.close(); }
});

test("cancelling Chrome debugging removes the controls and restores the viewport", async () => {
  const { page, tabId } = await open();
  try {
    await size(page, 500, 400);
    await worker.evaluate(id => chrome.debugger.detach({ tabId: id }), tabId);
    await page.locator("viewport-lab-controls").waitFor({ state: "detached", timeout: 8000 });
    await waitSize(page, 1200, 800);
  } finally { await page.close(); }
});

test("clicks, typing, scrolling and anchor navigation retain the chosen viewport", async () => {
  const { page, tabId } = await open();
  try {
    for (const [width, height] of [[500, 400], [1200, 800]]) {
      await size(page, width, height);
      const scale = Math.min(1, 1200 / width, 800 / height);
      await page.evaluate(() => scrollTo(0, 0));
      await clickPageElement(page, "#state", scale);
      assert.equal(await page.evaluate(() => document.activeElement.id), "state");
      await page.keyboard.type("interaction");
      await waitSize(page, width, height);
      await page.keyboard.press("Tab");
      await waitSize(page, width, height);
      await clickPageElement(page, "#click", scale);
      await waitSize(page, width, height);
      await page.mouse.wheel(0, 250);
      await page.waitForFunction(() => scrollY > 0);
      await waitSize(page, width, height);
      await clickPageElement(page, "#jump", scale);
      await waitSize(page, width, height);
      await clickPageElement(page, "#lower-state", scale);
      assert.equal(await page.evaluate(() => document.activeElement.id), "lower-state");
      await page.keyboard.type("more interaction");
      await waitSize(page, width, height);
      assert.equal(await page.locator("viewport-lab-controls").count(), 1);
    }
  } finally { await page.close(); }
});

async function firstPagePixel(tabId) {
  const { data } = await worker.evaluate(id => chrome.debugger.sendCommand({ tabId: id }, "Page.captureScreenshot", {
    format: "png", captureBeyondViewport: false
  }), tabId);
  const png = Buffer.from(data, "base64");
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  assert.ok([2, 6].includes(png[25]), "Chromium must capture RGB or RGBA PNGs");
  const channels = png[25] === 2 ? 3 : 4;
  const stride = png.readUInt32BE(16) * channels + 1;
  const pixels = inflateSync(Buffer.concat(chunks));
  let previous = [0, 0, 0];
  // Read the first pixel just below the 40px strip. At the left edge the
  // Sub predictor is zero and Paeth reduces to the pixel above.
  for (let y = 0; y <= 41; y++) {
    const offset = y * stride;
    const filter = pixels[offset];
    previous = previous.map((above, channel) => {
      const predictor = [0, 0, above, Math.floor(above / 2), above][filter];
      assert.ok(predictor !== undefined, "Supported PNG row filter");
      return (pixels[offset + channel + 1] + predictor) & 255;
    });
  }
  return previous;
}

test("the painted viewport follows scrolling instead of keeping a fixed crop", async () => {
  const { page, tabId } = await open("/paint");
  try {
    await size(page, 500, 400);
    assert.deepEqual(await firstPagePixel(tabId), [255, 0, 0]);
    await page.mouse.move(250, 200);
    await page.mouse.wheel(0, 500);
    await page.waitForFunction(() => scrollY >= 500);
    await waitSize(page, 500, 400);
    assert.deepEqual(await firstPagePixel(tabId), [0, 0, 255]);
    assert.deepEqual(await windowBounds(page), nativeWindow);
  } finally { await page.close(); }
});

test("focusing an offscreen input keeps the responsive viewport and paints the focused area", async () => {
  const { page, tabId } = await open("/paint");
  try {
    await size(page, 500, 300);
    assert.deepEqual(await firstPagePixel(tabId), [255, 0, 0]);
    await page.getByRole("textbox", { name: "Campo fuori vista" }).click();
    await page.waitForFunction(() => document.activeElement.id === "focus" && scrollY > 400);
    await waitSize(page, 500, 300);
    assert.deepEqual(await firstPagePixel(tabId), [0, 0, 255]);
    assert.equal(await page.locator("viewport-lab-controls").count(), 1);
  } finally { await page.close(); }
});
