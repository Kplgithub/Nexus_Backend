/**
 * CSV writer with spreadsheet formula-injection protection: any cell starting
 * with = + - @ (or tab/CR) is prefixed with a single quote.
 */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens UTF-8 (₹, Hindi names) correctly.
  return '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
