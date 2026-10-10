// ════════════════════════════
// Polyglot  export/pdf-styles.ts
// ════════════════════════════
// Print stylesheet for the A5 flashcard deck (see export/pdf.ts).
// Kept apart from the templates so markup and design can be edited independently.
export const PDF_STYLES = /* css */ `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

:root {
    --ink:        #1a1a2e;
    --hairline:   #e8e8f0;
    --level:      #888;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

@page {
    size: A5 landscape;
    margin: 0;
}

body {
    font-family: 'Inter', 'Noto Sans', 'Noto Sans JP', 'Noto Sans KR', 'Noto Sans SC', sans-serif;
    background: #f0f0f0;
    color: var(--ink);
}

/* ── Card base ──────────────────────────────────────── */
.pg-card {
    width: 100vw;
    height: 100vh;
    page-break-after: always;
    display: flex;
    flex-direction: column;
    padding: 32px 40px 24px;
    position: relative;
    overflow: hidden;
}

/* Front: clean white */
.pg-front {
    background: #ffffff;
    border-bottom: 6px solid var(--hairline);
}

/* Back: very light tint */
.pg-back {
    background: #fafafa;
    border-bottom: 6px solid var(--hairline);
}

/* ── Card header ────────────────────────────────────── */
.pg-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 0;
}

.pg-level-badge {
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    padding: 3px 10px;
    border-radius: 100px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    background: var(--level);
}

.pg-level-badge[data-level="A1"], .pg-level-badge[data-level="A2"] { --level: #4caf7d; }
.pg-level-badge[data-level="B1"], .pg-level-badge[data-level="B2"] { --level: #2196f3; }
.pg-level-badge[data-level="C1"], .pg-level-badge[data-level="C2"] { --level: #9c27b0; }
.pg-level-badge[data-level="grammar"]  { --level: #ff9800; }
.pg-level-badge[data-level="sentence"] { --level: #607d8b; }
.pg-level-badge[data-level="idiom"]    { --level: #e91e63; }

.pg-pos-badge {
    font-size: 11px;
    font-weight: 600;
    color: #666;
    background: #f0f0f4;
    padding: 3px 10px;
    border-radius: 100px;
    letter-spacing: 0.03em;
}

.pg-card-num {
    margin-left: auto;
    font-size: 11px;
    font-weight: 500;
    color: #bbb;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
}

.pg-word-sm {
    font-size: 13px;
    font-weight: 600;
    color: #555;
    margin-left: auto;
    font-style: italic;
}

/* ── Card body ──────────────────────────────────────── */
.pg-card-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 12px;
}

/* Front — main word */
.pg-word {
    font-size: 52px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--ink);
    line-height: 1.1;
}

.pg-word rt {
    font-size: 0.38em;
    font-weight: 500;
    letter-spacing: 0;
    color: var(--ink);
    opacity: 0.75;
}

.pg-ipa {
    font-size: 20px;
    color: #7a7a9a;
    font-style: italic;
    letter-spacing: 0.02em;
}

.pg-orig-form {
    font-size: 16px;
    color: #aaa;
    font-style: italic;
}

/* Back — meaning */
.pg-meaning {
    font-size: 32px;
    font-weight: 600;
    color: var(--ink);
    line-height: 1.25;
}

.pg-context-meaning {
    font-size: 16px;
    color: #888;
    font-style: italic;
    padding-left: 2px;
}

.pg-collocs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
}

.pg-colloc-chip {
    font-size: 12px;
    background: #eef0ff;
    color: #4455aa;
    padding: 3px 10px;
    border-radius: 100px;
    font-weight: 500;
}

.pg-example {
    font-size: 14px;
    color: #444;
    font-style: italic;
    border-left: 3px solid #dde;
    padding-left: 12px;
    line-height: 1.6;
}

.pg-example-trans {
    font-size: 12px;
    color: #888;
    margin-top: 4px;
    font-style: normal;
}

/* ── Card footer ────────────────────────────────────── */
.pg-card-footer {
    text-align: center;
}

.pg-hint {
    font-size: 11px;
    color: #ccc;
    letter-spacing: 0.05em;
}

/* ── Conjugation section ────────────────────────────── */
.pg-section-title {
    width: 100vw;
    height: 100vh;
    page-break-after: always;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: var(--ink);
    color: #fff;
}
.pg-conj-section-title h2 {
    font-size: 48px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 12px;
}
.pg-conj-section-title p {
    font-size: 18px;
    color: rgba(255,255,255,0.55);
}

.pg-conj-page {
    width: 100vw;
    min-height: 100vh;
    page-break-after: always;
    padding: 32px 40px;
    background: #fff;
}

.pg-conj-header {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin-bottom: 24px;
    border-bottom: 2px solid var(--ink);
    padding-bottom: 12px;
}

.pg-conj-verb {
    font-size: 36px;
    font-weight: 700;
    color: var(--ink);
}

.pg-conj-trans {
    font-size: 18px;
    color: #888;
    font-style: italic;
}

.pg-conj-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 20px;
}

.pg-conj-tense {
    break-inside: avoid;
}

.pg-tense-name {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink);
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 1px;
}

.pg-tense-native {
    font-size: 11px;
    color: #999;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
}

.pg-conj-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
}

.pg-conj-table tr {
    border-bottom: 1px solid #f0f0f0;
}

.pg-person {
    color: #999;
    padding: 4px 8px 4px 0;
    font-size: 12px;
    white-space: nowrap;
}

.pg-form {
    font-weight: 600;
    color: var(--ink);
    padding: 4px 0;
}

/* ── Screen preview (non-print) ─────────────────────── */
@media screen {
    body { padding: 20px; }
    .pg-card {
        width: 148mm;
        height: 105mm;
        border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.12);
        margin: 12px auto;
        page-break-after: unset;
    }
    .pg-conj-page {
        width: 148mm;
        border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.10);
        margin: 12px auto;
        page-break-after: unset;
        min-height: unset;
    }
    .pg-section-title {
        width: 148mm;
        height: 60px;
        border-radius: 12px;
        margin: 12px auto;
        page-break-after: unset;
    }
}
`;
