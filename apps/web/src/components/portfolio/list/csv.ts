/**
 * apps/web has no papaparse/file-saver — this is the minimal replacement
 * apps/app's `unparse` + `saveAs` calls needed: build a CSV string from an
 * array of flat records and trigger a browser download. Ported behavior:
 * BOM-prefixed UTF-8, values needing escaping get double-quoted with `"`
 * doubled inside.
 */

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(",")),
  ];
  return lines.join("\r\n");
}

export function downloadCsv(rows: Record<string, unknown>[], fileName: string): void {
  const csvStr = toCsv(rows);
  const blob = new Blob(["﻿" + csvStr], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
