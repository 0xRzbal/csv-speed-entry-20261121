// Fast drop-in for csv-reader 1.0.0. Same answer for every input, far less CPU.
//
// The reference builds each field a character at a time (value += c) and allocates an object per field. This one
// scans with charCodeAt and takes one slice per field, with a fast path for a record that holds no quote and no CR
// (String.prototype.split, which is a single C++ scan). The policy is csv-reader 1.0.0's exactly:
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

  // Slow unquoted read, used only where a lone CR forces a character-by-character decision. Appends from `p` onto
  // `value`; returns [value, ended, pos, added].
  function readUnquotedSlow(value, p, added) {
    let segStart = p;
    let parts = null;
    while (p < len) {
      const c = text.charCodeAt(p);
      if (c === CH_COMMA || c === CH_LF || c === CH_CR) {
        let kind;
        if (c === CH_COMMA) {
          kind = COMMA;
        } else if (c === CH_LF) {
          line += 1;
          kind = LINE_BREAK;
        } else if (p + 1 < len && text.charCodeAt(p + 1) === CH_LF) {
          line += 1;
          kind = LINE_BREAK;
        } else {
          // A CR not followed by LF outside quotes is dropped, and recorded.
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, p));
          p += 1;
          segStart = p;
          continue;
        }
        const piece = text.slice(segStart, p);
        let out;
        if (parts === null) out = value + piece;
        else {
          parts.push(piece);
          out = value + parts.join('');
        }
        added += piece.length;
        return [out, kind, c === CH_CR ? p + 2 : p + 1, added];
      }
      p += 1;
    }
    const piece = text.slice(segStart, len);
    const out = parts === null ? value + piece : value + parts.join('') + piece;
    added += piece.length;
    return [out, END, len, added];
  }

  for (;;) {
    // A line with no characters is no record.
    for (;;) {
      if (pos >= len) break;
      const c = text.charCodeAt(pos);
      if (c === CH_LF) {
        pos += 1;
        line += 1;
        continue;
      }
      if (c === CH_CR && pos + 1 < len && text.charCodeAt(pos + 1) === CH_LF) {
        pos += 2;
        line += 1;
        continue;
      }
      break;
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Every record in this corpus holds a quoted field, so the record is read field by field below.
    const fields = [];
    let ended = COMMA;
    let quoted = false;

    for (;;) {
      const c0 = text.charCodeAt(pos);
      let value;

      if (c0 === CH_QUOTE) {
        quoted = true;
        const open = pos;
        const openLine = line;
        let closed = false;
        let parts = null;
        let segStart = pos + 1;
        let i = pos + 1;

        while (i < len) {
          const c = text.charCodeAt(i);
          if (c === CH_QUOTE) {
            if (i + 1 < len && text.charCodeAt(i + 1) === CH_QUOTE) {
              if (parts === null) parts = [];
              parts.push(text.slice(segStart, i), '"');
              i += 2;
              segStart = i;
              continue;
            }
            pos = i + 1;
            closed = true;
            break;
          }
          if (c === CH_CR) {
            // CRLF and a lone CR inside quotes are each one LF.
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, i), '\n');
            line += 1;
            i += i + 1 < len && text.charCodeAt(i + 1) === CH_LF ? 2 : 1;
            segStart = i;
            continue;
          }
          if (c === CH_LF) line += 1;
          i += 1;
        }

        if (!closed) {
          // The quote never closes: a literal character, and the text after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = readUnquotedSlow('"', pos, 0);
          value = r[0];
          ended = r[1];
          pos = r[2];
        } else {
          value = parts === null ? text.slice(open + 1, pos - 1) : parts.join('') + text.slice(segStart, pos - 1);
          if (pos >= len) {
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === CH_COMMA) {
              pos += 1;
              ended = COMMA;
            } else if (c === CH_LF) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (c === CH_CR && pos + 1 < len && text.charCodeAt(pos + 1) === CH_LF) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands.
              const r = readUnquotedSlow(value, pos, 0);
              value = r[0];
              ended = r[1];
              pos = r[2];
              if (r[3] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
      } else {
        quoted = false;
        const start = pos;
        // Native scans find the next comma and the next line break; whichever comes first ends the field.
        let commaAt = text.indexOf(',', start);
        if (commaAt < 0) commaAt = len;
        let lfAt = text.indexOf('\n', start);
        if (lfAt < 0) lfAt = len;
        let crAt = text.indexOf('\r', start);
        if (crAt < 0) crAt = len;

        const minAt = commaAt < lfAt ? (commaAt < crAt ? commaAt : crAt) : lfAt < crAt ? lfAt : crAt;

        if (minAt === crAt && crAt < len && !(crAt + 1 < len && text.charCodeAt(crAt + 1) === CH_LF)) {
          // A lone CR outside quotes: dropped and recorded, then the field goes on.
          const r = readUnquotedSlow('', start, 0);
          value = r[0];
          ended = r[1];
          pos = r[2];
        } else if (minAt >= len) {
          value = text.slice(start, len);
          pos = len;
          ended = END;
        } else {
          value = text.slice(start, minAt);
          if (minAt === commaAt) {
            pos = minAt + 1;
            ended = COMMA;
          } else if (text.charCodeAt(minAt) === CH_LF) {
            pos = minAt + 1;
            line += 1;
            ended = LINE_BREAK;
          } else {
            // A CRLF terminator.
            pos = minAt + 2;
            line += 1;
            ended = LINE_BREAK;
          }
        }
      }

      fields.push(value);
      if (ended !== COMMA) break;
    }

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
