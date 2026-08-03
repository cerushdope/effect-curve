// probe-extension.mjs — load the built extension in a real Chrome and use it.
//
// This is the only check that actually exercises the MV3 constraints: the CSP
// that blocks inline script and remote imports, the relative-path resolution
// under chrome-extension://, and whether the REST fallback can reach Supabase
// with no host permission granted. None of that reproduces on localhost.
//
//   node tools/build-extension.mjs && node tools/probe-extension.mjs

import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "extension");
const userDir = await mkdtemp(join(tmpdir(), "effect-curve-ext-"));

const ctx = await chromium.launchPersistentContext(userDir, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const logs = [];
ctx.on("console", (m) => { if (m.type() === "error") logs.push(`[error] ${m.text()}`); });
ctx.on("weberror", (e) => logs.push(`[PAGEERROR] ${e.error().message}`));

// The extension id isn't knowable ahead of time; take it from the worker URL.
let worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = new URL(worker.url()).host;
console.log("extension id:", extId);

const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") logs.push(`[error] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

// 400px wide: what the side panel actually gives you.
await page.setViewportSize({ width: 400, height: 900 });
await page.goto(`chrome-extension://${extId}/app/index.html`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

// Did the app boot at all, and over which transport?
const transport = await page.evaluate(async () => {
  const m = await import("./src/api/client.js");
  return m.transport();
});
console.log("transport:", transport, transport === "rest" ? "(correct — SDK is remote code, MV3 blocks it)" : "(UNEXPECTED)");

// A real query over the fallback path.
await page.fill(".searchbar__input", "diazepam");
await page.waitForTimeout(2000);
const options = await page.$$eval(".searchbar__option", (els) => els.map((e) => e.textContent.trim()).slice(0, 3));
console.log("search over REST:", options.length ? options.join(" | ") : "NO RESULTS");
if (options.length) {
  await page.click(".searchbar__option");
  await page.waitForTimeout(2000);
}

const readout = await page.$$eval(".readout__row", (els) => els.map((e) => e.innerText.replace(/\n+/g, " | ")));
console.log("readout:", readout.join("\n          ") || "(empty)");

// Does the chart have usable pixels at panel width?
const box = await page.$eval("#chart-region canvas", (c) => ({ w: c.clientWidth, h: c.clientHeight }));
console.log("chart at 400px:", `${box.w}x${box.h}`);

// Horizontal overflow is the classic narrow-layout failure.
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log("horizontal overflow:", overflow <= 0 ? "none" : `${overflow}px — LAYOUT BREAKS`);

await page.screenshot({ path: "tools/shot-extension-panel.png", fullPage: false });

const cspErrors = logs.filter((l) => /Content Security Policy|Refused to/i.test(l));
console.log("\nCSP violations:", cspErrors.length ? cspErrors.join("\n  ") : "none");
console.log("console errors:", logs.length ? logs.join("\n  ") : "clean");

await ctx.close();
await rm(userDir, { recursive: true, force: true });

const ok = transport === "rest" && options.length > 0 && overflow <= 0 && cspErrors.length === 0;
console.log(ok ? "\nextension OK" : "\nEXTENSION HAS PROBLEMS");
process.exit(ok ? 0 : 1);
