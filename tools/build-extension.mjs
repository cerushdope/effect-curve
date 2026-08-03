// build-extension.mjs — copy the frontend into extension/app/ and generate icons.
//
// Chrome requires every file an extension loads to live under the extension
// root, so the app has to be physically copied rather than referenced. This is
// the whole build: a recursive copy and three PNGs. No bundler, no transpiler —
// the app is plain ES modules and the side panel loads them natively, which is
// the same reason there's no build step for the web version either.
//
//   node tools/build-extension.mjs
//   -> load extension/ as an unpacked extension at chrome://extensions

import { cp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "frontend");
const dest = join(root, "extension", "app");

// ---- copy the app ---------------------------------------------------------- //
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(join(src, "index.html"), join(dest, "index.html"));
await cp(join(src, "src"), join(dest, "src"), { recursive: true });

// ---- guard the MV3 rules --------------------------------------------------- //
// These two mistakes are silent: the panel just renders blank with a CSP error
// buried in a devtools console most people never open for an extension page.
const html = await readFile(join(dest, "index.html"), "utf8");
const problems = [];
if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
  problems.push("index.html has an inline <script> — MV3's CSP blocks it. Move it to a file.");
}
if (/(?:src|href)="\//.test(html)) {
  problems.push('index.html has a root-absolute path ("/…") — an extension page has no site root.');
}
for (const [file, text] of await readAll(join(dest, "src"))) {
  if (/from\s+["']https?:\/\//.test(text)) {
    problems.push(`${file} statically imports remote code — MV3 forbids it. Use a dynamic import with a fallback.`);
  }
  if (/from\s+["']\//.test(text)) {
    problems.push(`${file} has a root-absolute import.`);
  }
}
if (problems.length) {
  console.error("Extension build failed:\n  " + problems.join("\n  "));
  process.exit(1);
}

// ---- icons ----------------------------------------------------------------- //
// A flat-coloured PNG, written by hand rather than pulled from a dependency —
// it is ~40 lines of zlib and CRC and saves the project its only build-time
// package. Replace with real artwork whenever you have some.
await mkdir(join(root, "extension", "icons"), { recursive: true });
for (const size of [16, 48, 128]) {
  await writeFile(join(root, "extension", "icons", `icon${size}.png`), pngSquare(size, [46, 77, 84]));
}

console.log(`Built extension/app from frontend/ (${(await readAll(dest)).length} files).`);
console.log("Load unpacked: chrome://extensions -> Developer mode -> Load unpacked -> select extension/");

// ---------------------------------------------------------------------------- //
async function readAll(dir, out = []) {
  const { readdir } = await import("node:fs/promises");
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await readAll(p, out);
    else if (/\.(js|html|css)$/.test(e.name)) out.push([e.name, await readFile(p, "utf8")]);
  }
  return out;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function pngSquare(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (size * 3 + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
