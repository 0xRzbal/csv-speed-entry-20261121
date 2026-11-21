// Fast drop-in for csv-reader 1.0.0. Same answer for every input, far less CPU.
//
// RAW-JSON BYTE MODEL, EMIT AS YOU GO. The driver hands solveCase a view of one case's text field
// EXACTLY as stored inside cases.json, i.e. already JSON-escaped:
//   \r -> 5C 72   \n -> 5C 6E   \" -> 5C 22   \\ -> 5C 5C   \uXXXX -> 6 bytes   other -> 1 raw byte
// The input already IS the JSON encoding of every field, so a clean field's answer bytes are the
// raw range copied VERBATIM into the output buffer (one memcpy per field): no decode, no re-escape,
// no object graph, no JSON.stringify, no per-field allocation. Only three things ever need
// rewriting, each a small substitution, not a decode:
//   - a doubled quote inside a quoted field (\"\" , 4 bytes) is ONE literal quote -> \"
//   - a CR or CRLF inside a quoted field is read as LF                        -> \n
//   - a lone CR in an unquoted field is dropped                               (stray_cr)
//
// Policy (csv-reader 1.0.0 exactly):
//   - a U+FEFF at the very start is dropped (EF BB BF as raw bytes);
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled; each CRLF and lone
//     CR inside it is one LF; what follows its closing quote, up to the next comma or line break,
//     is appended as it stands (quote_junk, when the field ends); a quote that never closes is a
//     literal character and the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it
//     (every record when header is false), each padded with "" (short_row, fields: its count) or
//     cut (long_row, extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} (+fields / +extra): line the 1-based line its record starts
//     on (every LF, CRLF and lone CR inside a quoted field counted), row its record's index in rows
//     (null for the header), in the order met.

const COMMA = 0x2c;
const BS = 0x5c;
const QUOTE = 0x22;
const N = 0x6e; // 'n' of \n
const R = 0x72; // 'r' of \r
const BOM1 = 0xef, BOM2 = 0xbb, BOM3 = 0xbf;

/**
 * Answers one case into a fresh buffer. Returns a Buffer holding the JSON
 * {columns, rows, errors} for the case (a view of an internal buffer — copy or use at once).
 * @param {Buffer} v one case's text-field bytes, JSON-escaped, bounded
 * @param {boolean} header
 */
export function solveCaseBuf(v, header) {
  const b = v.length;
  // The generator's shapes stay under 4x input; growth covers anything beyond.
  let out = Buffer.allocUnsafe(b * 2 + 65536);
  let cap = out.length;
  let o = 0;

  const errs = [];
  const fieldPos = [];

  let columnsDone = false;
  let width = -1;
  let rowsCount = 0;
  let rowsStarted = false;

  let pos = 0;
  let line = 1;
  if (b >= 3 && v[0] === BOM1 && v[1] === BOM2 && v[2] === BOM3) pos = 3;

  let recordLine = 1;
  let recordRow = null;

  function ensure(need) {
    if (o + need <= cap) return;
    cap = Math.max(cap * 2, o + need);
    const bigger = Buffer.allocUnsafe(cap);
    out.copy(bigger, 0, 0, o);
    const delta = cap - out.length;
    for (let i = 0; i < fieldPos.length; i++) fieldPos[i] += delta;
    out = bigger;
  }

  // Single-byte literals (quotes, commas, brackets) written straight into the buffer: no string
  // encoding, no Buffer.write machinery. This is the hottest write path (3+ per field).
  function writeByte(x) {
    if (o + 1 > cap) ensure(1);
    out[o++] = x;
  }

  function writeAscii(s) {
    const n = Buffer.byteLength(s, 'utf8');
    ensure(n);
    o += out.write(s, o, 'utf8'); // advance by BYTES written (the string may hold multibyte)
  }

  function writeRange(s, e) {
    const n = e - s;
    if (n <= 0) return;
    ensure(n);
    if (n <= 24) { // short fields: a byte loop beats the memcpy call overhead
      while (s < e) out[o++] = v[s++];
    } else {
      v.copy(out, o, s, e);
      o += n;
    }
  }

  function pushErr(code, middle) {
    errs.push(`{"code":"${code}","line":${recordLine},"row":${recordRow === null ? 'null' : recordRow}${middle || ''}}`);
  }

  // Scans an unquoted field from pos, writing its JSON string body (between the quotes the caller
  // writes) straight to the output. A lone CR is dropped and recorded (stray_cr). Returns how the
  // field ended: 0 comma, 1 line break, 2 end. pos and line are kept current.
  function scanUnquoted() {
    let i = pos;
    let seg = i;
    for (;;) {
      if (i >= b) { writeRange(seg, b); pos = b; return 2; }
      const x = v[i];
      if (x === COMMA) { writeRange(seg, i); pos = i + 1; return 0; }
      if (x === BS && i + 1 < b) {
        const y = v[i + 1];
        if (y === N) { writeRange(seg, i); pos = i + 2; line += 1; return 1; }
        if (y === R) {
          if (i + 3 < b && v[i + 2] === BS && v[i + 3] === N) {
            writeRange(seg, i); pos = i + 4; line += 1; return 1;
          }
          pushErr('stray_cr');
          writeRange(seg, i);
          i += 2;
          seg = i;
          continue;
        }
        i += 2; // any other escape (\", \\, \uXXXX): verbatim in the range
        continue;
      }
      i += 1;
    }
  }

  // Scans a quoted field whose opening \" starts at openBs (the caller has written the opening
  // ASCII quote). Writes the body as it goes. Returns 0 closed (pos after the closing escape), or
  // -1 unterminated (pos and line restored to just after the opening quote / its line).
  function scanQuoted(openBs) {
    const openLine = line;
    let i = openBs + 2;
    let seg = i;
    for (;;) {
      if (i >= b) { pos = openBs + 2; line = openLine; return -1; }
      const x = v[i];
      if (x === BS && i + 1 < b) {
        const y = v[i + 1];
        if (y === QUOTE) {
          if (i + 3 < b && v[i + 2] === BS && v[i + 3] === QUOTE) {
            // doubled quote: one literal quote
            writeRange(seg, i);
            writeAscii('\\\"');
            i += 4;
            seg = i;
            continue;
          }
          writeRange(seg, i); // the closing escape itself is no value bytes
          pos = i + 2;
          return 0;
        }
        if (y === R) {
          // CR or CRLF inside quotes -> one LF
          writeRange(seg, i);
          writeAscii('\\n');
          line += 1;
          i += i + 3 < b && v[i + 2] === BS && v[i + 3] === N ? 4 : 2;
          seg = i;
          continue;
        }
        if (y === N) { line += 1; i += 2; continue; } // \n verbatim: the answer keeps those bytes
        i += 2;
        continue;
      }
      i += 1;
    }
  }

  // Reads one whole field from pos (quote-opening, junk, unterminated all handled), writing its
  // JSON string value. Returns how it ended: 0 comma, 1 line break, 2 end.
  function readField() {
    if (v[pos] === BS && pos + 1 < b && v[pos + 1] === QUOTE) {
      writeByte(QUOTE);
      const openBs = pos;
      const emitStart = o; // to undo any partial emission if the quote turns out unterminated
      let ended;
      if (scanQuoted(openBs) === -1) {
        o = emitStart; // the abandoned scan may already have written substitutions
        // the opening quote is a literal character; the text after it is read again as unquoted
        pushErr('unterminated_quote');
        writeAscii('\\\"');
        ended = scanUnquoted();
        writeByte(QUOTE);
        return ended;
      }
      // closed: what follows up to the next comma or line break is appended as it stands
      if (pos >= b) { writeByte(QUOTE); return 2; }
      const c = v[pos];
      if (c === COMMA) { writeByte(QUOTE); pos += 1; return 0; }
      if (c === BS && pos + 1 < b) {
        const y = v[pos + 1];
        if (y === N) { writeByte(QUOTE); pos += 2; line += 1; return 1; }
        if (y === R && pos + 3 < b && v[pos + 2] === BS && v[pos + 3] === N) {
          writeByte(QUOTE); pos += 4; line += 1; return 1;
        }
      }
      const before = o;
      ended = scanUnquoted();
      if (o > before) pushErr('quote_junk');
      writeByte(QUOTE);
      return ended;
    }
    writeByte(QUOTE);
    const ended = scanUnquoted();
    writeByte(QUOTE);
    return ended;
  }

  // The scaffolding before the first record.
  if (header) writeAscii('{"columns":[');
  else writeAscii('{"columns":null,"rows":[');

  for (;;) {
    // Lines with no characters are no records.
    for (;;) {
      if (pos >= b) break;
      if (v[pos] === BS && pos + 1 < b) {
        const y = v[pos + 1];
        if (y === N) { pos += 2; line += 1; continue; }
        if (y === R && pos + 3 < b && v[pos + 2] === BS && v[pos + 3] === N) { pos += 4; line += 1; continue; }
      }
      break;
    }
    if (pos >= b) break;

    recordLine = line;
    recordRow = header && !columnsDone ? null : rowsCount;

    const isHeaderRec = header && !columnsDone;
    const openStart = o;
    const prevRowsStarted = rowsStarted;
    if (!isHeaderRec) {
      writeAscii(rowsStarted ? ',[' : '[');
      rowsStarted = true;
    }

    fieldPos.length = 0;
    let ended = 0;
    let quoted = false;
    for (;;) {
      fieldPos.push(o);
      quoted = v[pos] === BS && pos + 1 < b && v[pos + 1] === QUOTE;
      ended = readField();
      if (ended !== 0) break;
      writeByte(COMMA); // separator between the row's fields
    }

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fieldPos.length === 1 && !quoted && o - fieldPos[0] === 2) {
      o = openStart;
      if (!isHeaderRec) rowsStarted = prevRowsStarted;
      continue;
    }

    if (width < 0) width = fieldPos.length;
    if (isHeaderRec) {
      columnsDone = true;
      writeAscii('],"rows":[');
      continue;
    }

    const nf = fieldPos.length;
    if (nf < width) {
      pushErr('short_row', `,"fields":${nf}`);
      for (let f = nf; f < width; f++) writeAscii(',""');
    } else if (nf > width) {
      const cut = fieldPos[width]; // the first extra field's own bytes (separators already inside)
      const extraJson = out.toString('utf8', cut, o);
      o = cut - 1; // drop the separator comma that preceded the first extra field
      pushErr('long_row', `,"extra":[${extraJson}]`);
    }
    writeAscii(']');
    rowsCount += 1;
  }

  if (header && !columnsDone) writeAscii('],"rows":['); // no record at all: columns []
  writeAscii(']'); // close the rows array (its [ was opened by the scaffolding/header close)
  writeAscii(',"errors":[');
  for (let i = 0; i < errs.length; i++) { if (i) writeAscii(','); writeAscii(errs[i]); }
  writeAscii(']}');

  return out.subarray(0, o);
}

/** run-compatible string answer (used by tests; the driver uses solveCaseBuf). */
export function solveCase(v, header) {
  return solveCaseBuf(v, header).toString('utf8');
}
