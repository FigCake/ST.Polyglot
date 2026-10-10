// ════════════════════════════
// Polyglot  export/download.ts
// ════════════════════════════
// Saves text as a file via a temporary download link.
/** Downloads `content` as `filename`. Text files get a UTF-8 BOM so spreadsheet apps detect the encoding. */
export function downloadText(content, filename, type = 'text/plain') {
    const bom = type === 'text/plain' ? '﻿' : '';
    const url = URL.createObjectURL(new Blob([bom + content], { type: `${type};charset=utf-8` }));
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}
/** Downloads a Blob as `filename`. */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked a little later: some browsers start reading the Blob after click() returns
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
