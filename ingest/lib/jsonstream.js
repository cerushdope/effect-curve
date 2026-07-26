// jsonstream.js — stream top-level objects out of a huge `{"meta":…,"results":[…]}`
// document without ever holding the whole thing in memory.
//
// The openFDA label partitions are ~400 MB–1 GB uncompressed; JSON.parse would
// blow the heap. This walks the byte stream tracking brace depth + string state
// and yields one parsed object per element of the `results` array.

import { StringDecoder } from "node:string_decoder";

/**
 * @param {AsyncIterable<Buffer>} readable
 * @yields {object} one element of the `results` array
 */
export async function* streamResults(readable) {
  // A multi-byte UTF-8 char can straddle a chunk boundary; StringDecoder holds
  // the partial bytes back instead of emitting U+FFFD.
  const decoder = new StringDecoder("utf8");

  let buf = "";
  let scanned = 0; // chars of `buf` already examined
  let started = false; // have we entered the results array?
  let depth = 0;
  let inStr = false;
  let esc = false;
  let objStart = -1;

  for await (const chunk of readable) {
    buf += decoder.write(chunk);

    if (!started) {
      const k = buf.indexOf('"results"');
      if (k === -1) {
        // Keep a short tail in case the key itself straddles a boundary.
        if (buf.length > 64) buf = buf.slice(-64);
        scanned = 0;
        continue;
      }
      const b = buf.indexOf("[", k);
      if (b === -1) {
        buf = buf.slice(k);
        scanned = 0;
        continue;
      }
      started = true;
      buf = buf.slice(b + 1);
      scanned = 0;
    }

    for (let i = scanned; i < buf.length; i++) {
      const c = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") {
        if (depth === 0) objStart = i;
        depth++;
        continue;
      }
      if (c === "}") {
        depth--;
        if (depth === 0 && objStart >= 0) {
          yield JSON.parse(buf.slice(objStart, i + 1));
          objStart = -1;
        }
        continue;
      }
      // End of the results array — nothing after it matters to us.
      if (c === "]" && depth === 0) return;
    }

    // Compact: drop everything already consumed, keep only a partial object.
    if (depth > 0 && objStart >= 0) {
      buf = buf.slice(objStart);
      objStart = 0;
      scanned = buf.length;
    } else {
      buf = "";
      scanned = 0;
    }
  }
}
