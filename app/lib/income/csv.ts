/**
 * CSV as RFC 4180 writes it: fields separated by commas, a field in double
 * quotes when it holds a comma, a quote or a line break, a quote inside one
 * doubled. Pure and client-safe.
 */

export interface CsvTable {
  /** The first record. */
  header: string[];
  /** Every record after it, as read; a record may have more or fewer fields than the header. */
  records: string[][];
  /** What the file used, so a copy can be written the same way. */
  bom: boolean;
  newline: '\n' | '\r\n';
  trailingNewline: boolean;
}

/** Read CSV text. Null when a quoted field never closes. A line with nothing on it is skipped. */
export function parseCsv(input: string): CsvTable | null {
  const bom = input.charCodeAt(0) === 0xfeff;
  const text = bom ? input.slice(1) : input;
  const newline: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = text.endsWith('\n');
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
      fieldStarted = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      if (!(record.length === 1 && record[0] === '')) records.push(record);
      record = [];
      field = '';
      fieldStarted = false;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (quoted) return null;
  if (field !== '' || record.length > 0) {
    record.push(field);
    if (!(record.length === 1 && record[0] === '')) records.push(record);
  }
  if (records.length === 0) return { header: [], records: [], bom, newline, trailingNewline };
  return { header: records[0], records: records.slice(1), bom, newline, trailingNewline };
}

/** One field as CSV writes it. */
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Write a table back as CSV, the way the file it was read from was written. */
export function writeCsv(table: CsvTable): string {
  const lines = [table.header, ...table.records].map((record) => record.map(field).join(','));
  return `${table.bom ? '﻿' : ''}${lines.join(table.newline)}${table.trailingNewline ? table.newline : ''}`;
}
