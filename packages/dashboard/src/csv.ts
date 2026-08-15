/** RFC 4180-ish CSV — quote a field only when it needs it, double up embedded quotes. */
function escapeCsvField(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serializes rows to CSV and triggers a browser download — client-side only, no backend round trip. */
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const csv = [headers, ...rows].map((row) => row.map(escapeCsvField).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
