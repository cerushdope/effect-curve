// unzip.js — read the single entry out of a ZIP as a stream, with no deps.
//
// Every openFDA download partition is a ZIP containing exactly one .json member,
// deflate-compressed. Rather than pull in a zip library we parse the local file
// header by hand and pipe the payload through zlib's raw inflate.
//
// Local file header layout (APPNOTE 4.3.7):
//   0  u32  signature 0x04034b50
//   8  u16  compression method (0 = stored, 8 = deflate)
//  26  u16  file name length
//  28  u16  extra field length
//  30  ...  file name, extra field, then the compressed payload

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInflateRaw } from "node:zlib";

const LOCAL_HEADER_SIG = 0x04034b50;

/**
 * @param {string} zipPath
 * @returns {Promise<import("node:stream").Readable>} decompressed bytes
 */
export async function openZipEntry(zipPath) {
  const fh = await open(zipPath, "r");
  let dataOffset;
  let method;
  try {
    const head = Buffer.alloc(30);
    const { bytesRead } = await fh.read(head, 0, 30, 0);
    if (bytesRead < 30) throw new Error(`truncated zip: ${zipPath}`);
    if (head.readUInt32LE(0) !== LOCAL_HEADER_SIG) {
      throw new Error(`not a zip (bad signature): ${zipPath}`);
    }
    method = head.readUInt16LE(8);
    dataOffset = 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  } finally {
    await fh.close();
  }

  const raw = createReadStream(zipPath, { start: dataOffset });
  if (method === 0) return raw; // stored
  if (method !== 8) throw new Error(`unsupported zip compression method ${method}`);

  const inflate = createInflateRaw();
  // The reader stops at the closing `]` of the results array and destroys the
  // stream, so a late EPIPE/"unexpected end" on teardown is expected, not a fault.
  inflate.on("error", (err) => {
    if (!inflate.destroyed) inflate.destroy();
    if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") { /* swallowed on teardown */ }
  });
  return raw.pipe(inflate);
}
