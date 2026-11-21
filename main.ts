// The program the harness runs (node /bot/main.ts). It answers every case of /input/cases.json
// with solveCaseBuf() from solve.js and writes /output/answers.json: a JSON array of the answers,
// one per case and in the cases' order.
//
// This driver reads cases.json as raw bytes and hands solve.js each case's text field EXACTLY as
// stored (the JSON-escaped bytes between its quotes), skipping the decode of the 11 MB input and
// the re-encode of the 12 MB output: solve.js answers in that same raw-JSON byte domain and emits
// its answer bytes straight into a buffer (see its header). The bytes written are the same JSON
// array the house driver's JSON.stringify produces.
//
// Cases.json is a JSON array of {"id","input"} whose input holds {"text","header"} (the generator's
// order: text, then header). A literal quote inside a JSON string is always the two bytes \" — so
// the byte sequence "text":" can occur only as the key itself, never inside a value, and the
// closing quote of a text value is a 0x22 preceded by an even number of 0x5C bytes.

import { readFileSync, writevSync, openSync, closeSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it
// (the house baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types). */
const { solveCaseBuf } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  solveCaseBuf: (text: Buffer, header: boolean) => Buffer;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(INPUT_DIR + '/cases.json');

const TEXT_KEY = Buffer.from('"text":"');
const HEADER_KEY = Buffer.from('"header":');
const QUOTE = 0x22;
const BS = 0x5c;

const pieces: Buffer[] = [Buffer.from('[')];
let n = 0;
let p = 0;
for (;;) {
  const t = raw.indexOf(TEXT_KEY, p);
  if (t === -1) break;
  const bodyStart = t + TEXT_KEY.length;
  // the closing quote of the text value: a 0x22 with an even number of 0x5C bytes before it
  let q = bodyStart;
  let close = -1;
  for (;;) {
    q = raw.indexOf(QUOTE, q);
    if (q === -1) throw new Error('cases.json holds a text value that never closes');
    let k = q - 1;
    let bs = 0;
    while (k >= bodyStart && raw[k] === BS) { bs += 1; k -= 1; }
    if (bs % 2 === 0) { close = q; break; }
    q += 1;
  }
  // this case's header flag: between the text value's end and the next case's text key
  const nextT = raw.indexOf(TEXT_KEY, close + 1);
  const bound = nextT === -1 ? raw.length : nextT;
  let header = false;
  const h = raw.indexOf(HEADER_KEY, close + 1);
  if (h !== -1 && h < bound) {
    let c = h + HEADER_KEY.length;
    while (c < bound && (raw[c] === 0x20 || raw[c] === 0x09)) c += 1;
    header = raw[c] === 0x74; // 't' of true
  }
  if (n++) pieces.push(Buffer.from(','));
  pieces.push(solveCaseBuf(raw.subarray(bodyStart, close), header));
  p = close + 1;
}
pieces.push(Buffer.from(']'));

const fd = openSync(OUTPUT_DIR + '/answers.json', 'w');
try { writevSync(fd, pieces); } finally { closeSync(fd); }
