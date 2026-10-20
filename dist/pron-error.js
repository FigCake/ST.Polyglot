// Why a pronunciation service (Azure scores, OpenAI transcription or advice)
// could not answer, so the check can say what to fix.
export class PronServiceError extends Error {
    kind;
    constructor(kind, message = kind) {
        super(message);
        this.kind = kind;
    }
}
