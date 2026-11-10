export type TableSnapshot = {
  headers: string[];
  rows: string[][];
};

export type ExportMeta = {
  title: string;
  subtitle: string;
};

export function snapshotRecords(
  fields: { key: string; label: string }[],
  rows: Record<string, unknown>[],
): TableSnapshot {
  return {
    headers: fields.map((field) => field.label),
    rows: rows.map((row) => fields.map((field) => formatCell(row[field.key]))),
  };
}

export function formatCell(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value.length > 0 ? value : "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function csvFromSnapshot(snapshot: TableSnapshot): string {
  const lines = [snapshot.headers.map(csvEscape).join(",")];
  for (const row of snapshot.rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export async function pdfFromSnapshot(snapshot: TableSnapshot, meta: ExportMeta): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const { autoTable } = await import("jspdf-autotable");
  const wide = snapshot.headers.length > 8;
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: "letter",
  });
  const margin = { top: 48, left: 28, right: 28, bottom: 32 };
  autoTable(doc, {
    head: [snapshot.headers],
    body: snapshot.rows,
    margin,
    styles: {
      font: "helvetica",
      fontSize: snapshot.headers.length > 14 ? 6 : snapshot.headers.length > 8 ? 7 : 8,
      cellPadding: wide ? 2 : 3,
      overflow: "linebreak",
      valign: "top",
      textColor: [27, 22, 84],
    },
    headStyles: {
      fillColor: [27, 22, 84],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      valign: "middle",
    },
    alternateRowStyles: {
      fillColor: [244, 246, 251],
    },
    horizontalPageBreak: wide,
    didDrawPage: () => {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(27, 22, 84);
      doc.text(meta.title, margin.left, 22);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(74, 86, 128);
      doc.text(meta.subtitle, margin.left, 36, {
        maxWidth: doc.internal.pageSize.getWidth() - margin.left - margin.right,
      });
    },
  });
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(74, 86, 128);
    doc.text(
      `Page ${page} of ${pages}`,
      doc.internal.pageSize.getWidth() - margin.right,
      doc.internal.pageSize.getHeight() - 14,
      { align: "right" },
    );
  }
  return doc.output("blob");
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportFilename(kind: "csv" | "pdf", page: number | null): string {
  const stamp = localStamp(new Date());
  const pagePart = page != null ? `-page-${page}` : "";
  return `beam-crash-events${pagePart}-${stamp}.${kind}`;
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function localStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
