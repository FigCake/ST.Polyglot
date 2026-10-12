// SillyTavern's connection profiles (its Connection Manager extension): which
// ones Polyglot can use, and sending a request through one.
//
//   connectionProfiles()   the profiles that can answer (chat or text completion)
//   findProfile(id)        one of them by id
//   profileSource(p)       its chat-completion source ('' for text completion)
//   sendThroughProfile()   one request with the profile's API, model, key and
//                          proxy, but not its preset: a roleplay preset's
//                          prompts and samplers must not reach study requests
//
// Everything comes from ST's context, so an ST without the Connection Manager
// (older, or the extension turned off) simply has no profiles.
import { getContext } from '../runtime.js';
const service = () => getContext().ConnectionManagerRequestService;
/** Profiles that can answer a request; [] when ST has no Connection Manager or it is turned off. */
export function connectionProfiles() {
    try {
        return service()?.getSupportedProfiles() ?? [];
    }
    catch {
        return [];
    }
}
export const findProfile = (id) => id ? connectionProfiles().find(p => p.id === id) : undefined;
/** The profile's chat-completion source ('openai', 'claude', …); '' for a text-completion profile. */
export const profileSource = (p) => getContext().CONNECT_API_MAP?.[p.api ?? '']?.source ?? '';
/** "Name (model)" for lists. */
export const profileLabel = (p) => p.model ? `${p.name || p.id} (${p.model})` : p.name || p.id;
/**
 * One request through the profile; the backend's raw answer (api.readReply
 * reads it). Text-completion profiles format the messages with their
 * instruct template. ST wraps every failure as "API request failed": the
 * original error is thrown instead, so a cancel stays an AbortError and a
 * provider's message reaches the user.
 */
export async function sendThroughProfile(profileId, messages, maxTokens, signal, overridePayload) {
    const svc = service();
    if (!svc)
        throw new Error('SillyTavern\'s Connection Manager is not available. Update SillyTavern or turn the extension on.');
    try {
        return await svc.sendRequest(profileId, messages, maxTokens, { stream: false, signal, extractData: false, includePreset: false, includeInstruct: true }, overridePayload);
    }
    catch (e) {
        const cause = e?.cause;
        throw cause instanceof Error ? cause : e;
    }
}
