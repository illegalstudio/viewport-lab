import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
const { chromium } = await import("playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = await readFile(resolve(root, "assets/logo-mark.svg"), "utf8");
const background = (mark, color) => mark.replace(/(<svg[^>]*>)/, `$1\n  <rect width="256" height="256" fill="${color}"/>`);
const variants = {
  "logo-mark": svg,
  "logo-light": background(svg, "#f8fafc"),
  "logo-dark": background(svg.replaceAll("#2563eb", "#ffffff"), "#0f172a")
};
await mkdir(resolve(root, "assets/icons"), { recursive: true });
const profile = await mkdtemp(resolve(root, ".icon-profile-"));
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, viewport: { width: 512, height: 512 }
  });
  const page = browser.pages()[0];
  for (const [name, mark] of Object.entries(variants)) {
    if (name !== "logo-mark") await writeFile(resolve(root, `assets/${name}.svg`), mark);
    await page.setContent(`<style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${mark}`);
    await page.screenshot({ path: resolve(root, `assets/${name}.png`), omitBackground: true });
  }
  await page.setContent(`<style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
  for (const size of [128, 48, 32, 16]) {
    await page.setViewportSize({ width: size, height: size });
    await page.screenshot({ path: resolve(root, `assets/icons/${size}.png`), omitBackground: true });
  }
} finally {
  try { await browser?.close(); }
  finally { await rm(profile, { recursive: true, force: true }); }
}
