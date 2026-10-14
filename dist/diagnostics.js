// Recent problems, kept in memory for a bug report: an AI reply that could
// not be used (with the start of what it said), a request that failed, a user
// file that could not be read or written. Settings → "Copy diagnostics" puts
// them on the clipboard with the version and connection type. Pure — no DOM,
// no ST imports. Nothing is recorded that holds an API key or an address.
/** Problems kept (the oldest goes first). */
const KEPT = 20;
/** Characters kept of a problem's detail (an AI reply can be long). */
const DETAIL_MAX = 500;
const problems = [];
export function recordProblem(where, detail, now = Date.now()) {
    const kept = detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail;
    problems.push({ at: now, where, detail: kept });
    if (problems.length > KEPT)
        problems.shift();
    console.warn(`[Polyglot] ${where}: ${kept}`);
}
export const recentProblems = () => [...problems];
/** An error's message, for notices and records. */
export const errorText = (e) => (e instanceof Error ? e.message : String(e));
/** The report: `facts` (version, connection, storage…) first, then the problems, newest last. */
export function diagnosticsReport(facts) {
    return [
        ...Object.entries(facts).map(([k, v]) => `${k}: ${v}`),
        '',
        problems.length ? 'Recent problems:' : 'No problems recorded in this session.',
        ...problems.map(p => `${new Date(p.at).toISOString()}  [${p.where}] ${p.detail}`),
    ].join('\n');
}
