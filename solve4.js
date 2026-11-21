// Fast drop-in for csv-reader 1.0.0: the same answer for every input, far less CPU.
//
// The reference builds every field one character at a time (value += c). This one finds each field's end with a
// native scan and takes one slice, so a field costs one allocation instead of one per character, and a quoted field
// costs one indexOf per run of text rather than one iteration per character.
//
// The broken-row policy is csv-reader 1.0.0's exactly:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it one quote, and each
//     CRLF or lone CR inside it is read as LF; what follows its closing quote, up to the next comma or line break, is
//     appended to it as it stands (quote_junk, when the field ends); a quote that never closes is read as a literal
//     character and the text after it is read again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records after it (every record when
//     header is false), each padded with "" (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF, CRLF and lone CR inside a
//     quoted field counted), row its record's index in rows (null for the header), in the order met.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const CH_COMMA = 44;
const CH_LF = 10;
const CH_CR = 13;
const CH_QUOTE = 34;
const CH_BOM = 0xfeff;

/**
 * The reading of one CSV input, {text, header}: {columns, rows, errors}.
 * @param {{text: unknown, header?: unknown}} input
 */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];

  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === CH_BOM) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // The lines a run of quoted text adds: every CR is one (a CRLF counting once), and so is a lone LF.
  function linesIn(s) {
    let n = 0;
    let i = 0;
    const n2 = s.length;
    while (i < n2) {
      const c = s.charCodeAt(i);
      if (c === CH_LF) {
        n += 1;
      } else if (c === CH_CR) {
        n += 1;
        if (i + 1 < n2 && s.charCodeAt(i + 1) === CH_LF) i += 1;
      }
      i += 1;
    }
    return n;
  }

  // CRLF and a lone CR inside quotes are each one LF.
  function crToLf(s) {
    return s.replace(/\r\n|\r/g, '\n');
  }

  while (pos < len) {
    // A line with no characters is no record.
    let c = text.charCodeAt(pos);
    while (c === CH_LF || (c === CH_CR && pos + 1 < len && text.charCodeAt(pos + 1) === CH_LF)) {
      pos += c === CH_LF ? 1 : 2;
      line += 1;
      if (pos >= len) break;
      c = text.charCodeAt(pos);
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let ended = COMMA;
    let quoted = false;

    for (;;) {
      let value;

      if (text.charCodeAt(pos) === CH_QUOTE) {
        quoted = true;
        const open = pos;
        const openLine = line;
        let parts = null;
        let segStart = pos + 1;
        let i = pos + 1;
        let closed = false;
        let closeAt = -1;

        // Native scan from i to the next quote; "" inside a quoted field is one quote and the scan goes on.
        for (;;) {
          const q = text.indexOf('"', i);
          if (q < 0) break;
          if (q + 1 < len && text.charCodeAt(q + 1) === CH_QUOTE) {
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, q), '"');
            i = q + 2;
            segStart = i;
            continue;
          }
          closeAt = q;
          closed = true;
          break;
        }

        if (!closed) {
          // The quote never closes: a literal character, and the text after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          // The field is the literal quote plus the unquoted read that follows it.
          let seg = pos;
          let acc = '"';
          for (;;) {
            let commaAt = text.indexOf(',', seg);
            let lfAt = text.indexOf('\n', seg);
            let crAt = text.indexOf('\r', seg);
            if (commaAt < 0) commaAt = len;
            if (lfAt < 0) lfAt = len;
            if (crAt < 0) crAt = len;
            const m = commaAt < lfAt ? (commaAt < crAt ? commaAt : crAt) : lfAt < crAt ? lfAt : crAt;
            if (m === crAt && crAt < len && !(crAt + 1 < len && text.charCodeAt(crAt + 1) === CH_LF)) {
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              acc += text.slice(seg, crAt);
              seg = crAt + 1;
              continue;
            }
            acc += text.slice(seg, m < len ? m : len);
            if (m >= len) {
              pos = len;
              ended = END;
            } else if (m === commaAt) {
              pos = m + 1;
              ended = COMMA;
            } else if (text.charCodeAt(m) === CH_LF) {
              pos = m + 1;
              line += 1;
              ended = LINE_BREAK;
            } else {
              pos = m + 2;
              line += 1;
              ended = LINE_BREAK;
            }
            break;
          }
          value = acc;
        } else {
          pos = closeAt + 1;
          if (parts === null) {
            const raw = text.slice(open + 1, closeAt);
            // Only a run that really holds a line break costs a scan; the rest are one slice.
            if (raw.indexOf('\r') >= 0 || raw.indexOf('\n') >= 0) {
              line += linesIn(raw);
              value = crToLf(raw);
            } else {
              value = raw;
            }
          } else {
            parts.push(text.slice(segStart, closeAt));
            let joined = '';
            for (let k = 0; k < parts.length; k++) {
              const piece = parts[k];
              if (piece.indexOf('\r') >= 0 || piece.indexOf('\n') >= 0) {
                line += linesIn(piece);
                joined += crToLf(piece);
              } else {
                joined += piece;
              }
            }
            value = joined;
          }

          if (pos >= len) {
            ended = END;
          } else {
            const ch = text.charCodeAt(pos);
            if (ch === CH_COMMA) {
              pos += 1;
              ended = COMMA;
            } else if (ch === CH_LF) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (ch === CH_CR && pos + 1 < len && text.charCodeAt(pos + 1) === CH_LF) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands, up to the next comma or line break.
              let added = 0;
              let seg = pos;
              for (;;) {
                let commaAt = text.indexOf(',', seg);
                let lfAt = text.indexOf('\n', seg);
                let crAt = text.indexOf('\r', seg);
                if (commaAt < 0) commaAt = len;
                if (lfAt < 0) lfAt = len;
                if (crAt < 0) crAt = len;
                const m = commaAt < lfAt ? (commaAt < crAt ? commaAt : crAt) : lfAt < crAt ? lfAt : crAt;
                if (m === crAt && crAt < len && !(crAt + 1 < len && text.charCodeAt(crAt + 1) === CH_LF)) {
                  errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                  const piece = text.slice(seg, crAt);
                  value += piece;
                  added += piece.length;
                  seg = crAt + 1;
                  continue;
                }
                const piece = text.slice(seg, m < len ? m : len);
                value += piece;
                added += piece.length;
                if (m >= len) {
                  pos = len;
                  ended = END;
                } else if (m === commaAt) {
                  pos = m + 1;
                  ended = COMMA;
                } else if (text.charCodeAt(m) === CH_LF) {
                  pos = m + 1;
                  line += 1;
                  ended = LINE_BREAK;
                } else {
                  pos = m + 2;
                  line += 1;
                  ended = LINE_BREAK;
                }
                break;
              }
              if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
      } else {
        quoted = false;
        const start = pos;
        // Native scans find the next comma and the next line break; whichever comes first ends the field.
        let commaAt = text.indexOf(',', start);
        let lfAt = text.indexOf('\n', start);
        let crAt = text.indexOf('\r', start);
        if (commaAt < 0) commaAt = len;
        if (lfAt < 0) lfAt = len;
        if (crAt < 0) crAt = len;
        const m = commaAt < lfAt ? (commaAt < crAt ? commaAt : crAt) : lfAt < crAt ? lfAt : crAt;

        if (m === crAt && crAt < len && !(crAt + 1 < len && text.charCodeAt(crAt + 1) === CH_LF)) {
          // A lone CR outside quotes is dropped and recorded; the field goes on after it.
          let seg = start;
          let acc = '';
          for (;;) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            acc += text.slice(seg, crAt);
            seg = crAt + 1;
            let c2 = text.indexOf(',', seg);
            let l2 = text.indexOf('\n', seg);
            let r2 = text.indexOf('\r', seg);
            if (c2 < 0) c2 = len;
            if (l2 < 0) l2 = len;
            if (r2 < 0) r2 = len;
            const m2 = c2 < l2 ? (c2 < r2 ? c2 : r2) : l2 < r2 ? l2 : r2;
            if (m2 === r2 && r2 < len && !(r2 + 1 < len && text.charCodeAt(r2 + 1) === CH_LF)) {
              crAt = r2;
              continue;
            }
            acc += text.slice(seg, m2 < len ? m2 : len);
            if (m2 >= len) {
              pos = len;
              ended = END;
            } else if (m2 === c2) {
              pos = m2 + 1;
              ended = COMMA;
            } else if (text.charCodeAt(m2) === CH_LF) {
              pos = m2 + 1;
              line += 1;
              ended = LINE_BREAK;
            } else {
              pos = m2 + 2;
              line += 1;
              ended = LINE_BREAK;
            }
            break;
          }
          value = acc;
        } else if (m >= len) {
          value = text.slice(start, len);
          pos = len;
          ended = END;
        } else {
          value = text.slice(start, m);
          if (m === commaAt) {
            pos = m + 1;
            ended = COMMA;
          } else if (text.charCodeAt(m) === CH_LF) {
            pos = m + 1;
            line += 1;
            ended = LINE_BREAK;
          } else {
            // A CRLF terminator.
            pos = m + 2;
            line += 1;
            ended = LINE_BREAK;
          }
        }
      }

      fields.push(value);
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
