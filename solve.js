// Fast drop-in for csv-reader 1.0.0 (make.fun): run(input) returns exactly csv-reader's
// {columns, rows, errors} for every {text, header}, but much faster than the reference,
// which reads one character at a time and builds every field by concatenation.
//
// Speed strategy, in order of how often each case occurs in the drawn sets:
//  1. Clean physical line (no '"' and no stray CR, CRLF stripped): one slice + split(',').
//     ~97% of records are clean, and this path is a handful of native calls per record.
//  2. Dirty lines: field-at-a-time scanning driven by native indexOf. The record's
//     pre-check already knows where the physical line ends, so an unquoted field on
//     a line with no stray CR needs a single indexOf (','): it ends at the comma or
//     at the known line end, a CR right before the LF being the CRLF break. Quoted
//     fields are found by indexOf('"') with "" escapes skipped in the scan, and their
//     content is sliced, not built char by char; CR/LF inside quotes is normalised
//     only when present.
//  3. No per-field allocations: the field readers share result slots, and there is no
//     regex and no per-character loop anywhere on the hot path.
//
// Semantics follow csv-reader 1.0.0 exactly (see the kit's vendor/csv-reader/index.js):
//  - U+FEFF at the very start is dropped; a record ends at LF or CRLF; a line left with
//    no characters is no record; a CR outside quotes not followed by LF is dropped
//    (stray_cr); a field opening with a quote runs to the next non-doubled quote, "" is
//    one quote, each CRLF or lone CR inside it reads as LF; junk after the closing
//    quote is appended as it stands (quote_junk, when the field ends); a quote that
//    never closes is a literal character and the text after it is read again as unquoted
//    (unterminated_quote); a quote inside an unquoted field is literal; fields stay
//    strings, never trimmed or converted; columns is the first record when header is
//    true, else null; rows are padded (short_row, with fields: its count) or cut
//    (long_row, with extra: the cut fields) to the first record's width; each error is
//    {code, line, row} in the order met, line the 1-based line its record starts on
//    (counting every LF, CRLF and lone CR inside quotes), row its record's index in
//    rows, null for the header.

/** How a field ended: 0 = comma (the record goes on), 1 = line break, 2 = end of text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

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
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Shared result slots for the field readers (single-threaded, strictly nested
  // calls: readQuoted calls readUnquoted for its junk and returns its result).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;
  // State of the current physical line, refreshed at each record start and after
  // a quoted field spans lines: lineEnd is the next LF at or after pos (-1 past
  // the last line), lineNoCR is true when the line holds no stray CR, so an
  // unquoted field on it can skip the '\r' search (a CR right before the LF is
  // the CRLF break).
  let lineEnd = -1;
  let lineNoCR = true;

  // Finishes one record: sets the width from the first record, takes the header,
  // or pads/cuts the row to the width, recording short_row / long_row as met.
  function finish(fields, recordLine, recordRow) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Refreshes the current line's state from pos. A CR right before the LF is the
  // CRLF break, not a stray CR; a lone CR at the end of the text is handled by
  // the unquoted reader's end-of-text branch.
  function refreshLineState() {
    lineEnd = text.indexOf('\n', pos);
    let end = lineEnd === -1 ? len : lineEnd;
    if (end > pos && text.charCodeAt(end - 1) === 13) end--;
    const r = text.indexOf('\r', pos);
    lineNoCR = !(r !== -1 && r < end);
  }

  // Reads unquoted characters onto `value` up to the next comma or line break.
  // A CR not followed by LF is dropped (stray_cr). Writes fValue, fEnded and
  // fAdded (the characters kept; the initial value is not counted).
  function readUnquoted(value, recordLine, recordRow) {
    let added = 0;
    if (lineNoCR) {
      // No stray CR on this line: the line end is already known, so one indexOf
      // (',') is enough to find where the field ends.
      const jC = text.indexOf(',', pos);
      if (jC === -1 && lineEnd === -1) {
        // End of text: a trailing lone CR is dropped (stray_cr).
        if (len > pos && text.charCodeAt(len - 1) === 13) {
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          value += text.slice(pos, len - 1);
          added += len - 1 - pos;
        } else if (pos < len) {
          value += text.slice(pos);
          added += len - pos;
        }
        pos = len;
        fValue = value;
        fEnded = END;
        fAdded = added;
        return;
      }
      if (jC !== -1 && (lineEnd === -1 || jC < lineEnd)) {
        value += text.slice(pos, jC);
        added += jC - pos;
        pos = jC + 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = added;
        return;
      }
      // The field ends at the known line end: a CR right before the LF is the
      // CRLF break, not part of the field.
      if (lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) {
        value += text.slice(pos, lineEnd - 1);
        added += lineEnd - 1 - pos;
      } else if (pos < lineEnd) {
        value += text.slice(pos, lineEnd);
        added += lineEnd - pos;
      }
      pos = lineEnd + 1;
      line++;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = added;
      return;
    }
    // Full scan: a stray CR may appear before the next comma or line break.
    // The line end is already known, so only ',' and '\r' are searched for.
    for (;;) {
      const jC = text.indexOf(',', pos);
      const jN = lineEnd;
      const jR = text.indexOf('\r', pos);
      let j = -1;
      let kind = -1;
      if (jC !== -1 && (j === -1 || jC < j)) { j = jC; kind = 0; }
      if (jN !== -1 && (j === -1 || jN < j)) { j = jN; kind = 1; }
      if (jR !== -1 && (j === -1 || jR < j)) { j = jR; kind = 2; }
      if (j === -1) {
        if (pos < len) {
          value += text.slice(pos);
          added += len - pos;
        }
        pos = len;
        fValue = value;
        fEnded = END;
        fAdded = added;
        return;
      }
      if (kind === 0) {
        value += text.slice(pos, j);
        added += j - pos;
        pos = j + 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = added;
        return;
      }
      if (kind === 1) {
        value += text.slice(pos, j);
        added += j - pos;
        pos = j + 1;
        line++;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      // A CR: CRLF ends the field as one line break, a lone CR is dropped.
      if (text.charCodeAt(j + 1) === 10) {
        value += text.slice(pos, j);
        added += j - pos;
        pos = j + 2;
        line++;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += text.slice(pos, j);
      added += j - pos;
      pos = j + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Writes fValue and fEnded.
  function readQuoted(recordLine, recordRow) {
    const open = pos;
    const openLine = line;
    let start = pos + 1;
    let closed = -1;
    let escaped = false;
    for (;;) {
      const j = text.indexOf('"', start);
      if (j === -1) break;
      if (text.charCodeAt(j + 1) === 34) {
        escaped = true;
        start = j + 2;
        continue;
      }
      closed = j;
      break;
    }
    if (closed === -1) {
      // The quote never closes: it is a literal character, and the text after it
      // is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"', recordLine, recordRow);
      return;
    }
    // The quoted content, with "" pairs collapsed to one quote when present.
    let content;
    if (escaped) {
      const parts = [];
      let s = open + 1;
      for (;;) {
        const j = text.indexOf('"', s);
        if (j === -1 || j >= closed) {
          parts.push(text.slice(s, closed));
          break;
        }
        parts.push(text.slice(s, j));
        parts.push('"');
        s = j + 2;
      }
      content = parts.join('');
    } else {
      content = text.slice(open + 1, closed);
    }
    // Each CRLF or lone CR inside quotes reads as LF; every LF, CRLF and lone CR
    // inside quotes counts one line. A quoted field that spans lines leaves the
    // closing quote on a later line, so the line's state is refreshed.
    if (content.indexOf('\n') !== -1 || content.indexOf('\r') !== -1) {
      let inc = 0;
      let k = -1;
      while ((k = content.indexOf('\r', k + 1)) !== -1) inc++;
      k = -1;
      let lf = 0;
      let crlf = 0;
      while ((k = content.indexOf('\n', k + 1)) !== -1) {
        lf++;
        if (k > 0 && content.charCodeAt(k - 1) === 13) crlf++;
      }
      line += inc + lf - crlf;
      if (content.indexOf('\r') !== -1) content = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      pos = closed + 1;
      refreshLineState();
    } else {
      pos = closed + 1;
    }
    if (pos >= len) {
      fValue = content;
      fEnded = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos++;
      fValue = content;
      fEnded = COMMA;
      fAdded = 0;
      return;
    }
    if (c === 10) {
      pos++;
      line++;
      fValue = content;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line++;
      fValue = content;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break; quote_junk when the field ends with anything appended.
    readUnquoted(content, recordLine, recordRow);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // The end of the physical line, and whether it holds a quote or a stray CR.
    // A CR right before the LF is the CRLF line break, not a stray CR; a CR at
    // the very end of the text is a lone CR (stray_cr) and is not part of a field.
    const jN = text.indexOf('\n', pos);
    let segEnd = jN === -1 ? len : jN;
    const eofCR = jN === -1 && segEnd > pos && text.charCodeAt(segEnd - 1) === 13;
    if (jN !== -1 && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd--;
    if (eofCR) segEnd--;
    const q = text.indexOf('"', pos);
    const hasQuote = q !== -1 && q < segEnd;
    const r = text.indexOf('\r', pos);
    const hasCR = r !== -1 && r < segEnd;
    lineEnd = jN;
    lineNoCR = !hasCR;

    if (!hasQuote && !hasCR) {
      // Clean line: no quotes, no stray CRs. A segment left empty here can only
      // be a lone CR at the end of the text: its stray_cr stays, no record.
      if (segEnd === pos) {
        if (eofCR) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos = len;
        continue;
      }
      if (eofCR) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      const fields = text.slice(pos, segEnd).split(',');
      pos = jN === -1 ? len : jN + 1;
      line++;
      finish(fields, recordLine, recordRow);
      continue;
    }

    // Field-at-a-time path for lines with quotes or stray CRs.
    const fields = [];
    let ended = END;
    let lastQuoted = false;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        readQuoted(recordLine, recordRow);
      } else {
        lastQuoted = false;
        readUnquoted('', recordLine, recordRow);
      }
      fields.push(fValue);
      ended = fEnded;
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    finish(fields, recordLine, recordRow);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
