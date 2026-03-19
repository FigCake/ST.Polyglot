// ════════════════════════════════════════════════════════════════════
// src/types/st-mock.ts
// ════════════════════════════════════════════════════════════════════
// Minimal runtime mock of SillyTavern globals for Vitest.
// Used via vitest.config.ts path aliases so ST imports resolve at
// test time without requiring the actual ST runtime.
// ════════════════════════════════════════════════════════════════════
export const extension_settings = {};
export const saveSettingsDebounced = () => { };
export const saveMetadataDebounced = () => { };
export const getRequestHeaders = () => ({});
export const getContext = () => ({
    chat: [],
    chatMetadata: {},
    chatCompletionSettings: {},
});
export const eventSource = {
    on: (_event, _cb) => { },
    off: (_event, _cb) => { },
    emit: (_event, ..._args) => { },
    makeFirst: (_event, _cb) => { },
};
export const event_types = {
    APP_READY: 'app_ready',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    CHAT_CHANGED: 'chat_changed',
    MESSAGE_SWIPED: 'message_swiped',
};
export const SECRET_KEYS = {
    OPENAI: 'api_key_openai',
    CLAUDE: 'api_key_claude',
    MAKERSUITE: 'api_key_makersuite',
    OPENROUTER: 'api_key_openrouter',
    DEEPSEEK: 'api_key_deepseek',
};
export const secret_state = {};
export class SlashCommandParser {
    static addCommandObject(_cmd) { }
}
export class SlashCommand {
    static fromProps(_props) { return new SlashCommand(); }
}
export const ARGUMENT_TYPE = {
    NUMBER: 'number',
    STRING: 'string',
    BOOLEAN: 'boolean',
};
export class SlashCommandNamedArgument {
    static fromProps(_props) {
        return new SlashCommandNamedArgument();
    }
}
