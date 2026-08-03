// package-extension.mjs — zip the extension for Chrome Web Store upload.
//
//   node tools/build-extension.mjs && node tools/package-extension.mjs
//   -> store-assets/out/effect-curve-<version>.zip
//
// Written by hand rather than shelling out, because there is no `zip` binary on
// this machine and PowerShell's Compress-Archive has a long history of writing
// backslash path separators into the archive, which the Web Store rejects.
// Roughly 80 lines of well-specified format beats a dependency or a gamble.
//
// Two things the Web Store is strict about, both enforced here:
//   - manifest.json must be at the ROOT of the zip, not inside a folder
//   - entry names must use forward slashes
//
// Timestamps are fixed so the same input produces a byte-identical zip.

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "extension");
const outDir = join(root, "store-assets", "out");

// Files that belong in the repo but not in the uploaded package.
const EXCLUDE = new Set(["README.md", ".DS_Store", "Thumbs.db"]);

const manifest = JSON.parse(await readFile(join(src, "manifest.json"), "utf8"));
const zipName = `effect-curve-${manifest.version}.zip`;

async function walk(dir, out = []) {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDE.has(e.name) || e.name.endsWith(".zip")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = await walk(src);
if (!files.some((f) => relative(src, f) === "manifest.json")) {
  console.error("No manifest.json at the extension root — refusing to package.");
  process.exit(1);
}
if (!files.some((f) => relative(src, f).startsWith("app"))) {
  console.error("extension/app is missing — run: node tools/build-extension.mjs");
  process.exit(1);
}

// ---- CRC32 ------------------------------------------------------------------ //
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A fixed DOS timestamp (2026-01-01 00:00:00) keeps the output reproducible.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const locals = [];
const central = [];
let offset = 0;

for (const file of files) {
  const name = relative(src, file).split("\\").join("/"); // forward slashes, always
  const data = await readFile(file);
  const deflated = deflateRawSync(data, { level: 9 });
  // Store rather than deflate when compression makes the entry bigger (tiny files).
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);            // version needed
  local.writeUInt16LE(0, 6);             // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, nameBuf, body);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);              // version made by
  cen.writeUInt16LE(20, 6);              // version needed
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(DOS_TIME, 12);
  cen.writeUInt16LE(DOS_DATE, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(body.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(0, 36);              // external attributes
  cen.writeUInt32LE(offset, 42);
  central.push(cen, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);

await mkdir(outDir, { recursive: true });
const zipPath = join(outDir, zipName);
await writeFile(zipPath, Buffer.concat([...locals, centralBuf, eocd]));

const size = (await stat(zipPath)).size;
console.log(`${zipName}  ${(size / 1024).toFixed(0)} KB  ${files.length} files`);
for (const f of files) console.log("  " + relative(src, f).split("\\").join("/"));
console.log(`\nUpload this file: store-assets/out/${zipName}`);
