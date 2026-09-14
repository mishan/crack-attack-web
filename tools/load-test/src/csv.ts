/**
 * csv.ts — append-only CSV with a fixed column list. Each row is appended
 * synchronously, so a run that dies part-way still leaves every row written.
 */

import { appendFileSync, writeFileSync } from 'node:fs';

/** One cell: numbers to at most 3 decimals, blanks for NaN/null, strings quoted as needed. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(Math.round(value * 1000) / 1000);
  }
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export class CsvWriter {
  constructor(
    readonly path: string,
    readonly columns: readonly string[],
  ) {
    writeFileSync(path, `${columns.join(',')}\n`);
  }

  /** Append a row; columns missing from `row` are left blank. */
  write(row: Readonly<Record<string, unknown>>): void {
    appendFileSync(this.path, `${this.columns.map((c) => csvCell(row[c])).join(',')}\n`);
  }
}
