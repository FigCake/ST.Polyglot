// The AI services Polyglot calls directly through ST's backend with ST's
// stored keys (not ST's own connection, a connection profile or a custom
// endpoint): one row each, in the order the settings list them.
//
//   source        ST's chat_completion_source for it
//   secret        its SECRET_KEYS name, to check a key is set before sending
//                 (none: ST handles Vertex AI's auth itself)
//   defaultModel  the model chosen the first time the provider is picked
//   models        suggestions for the model list (any model name is accepted)
const GEMINI = [
    'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview',
    'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
];
export const PROVIDERS = [
    { id: 'openai', label: 'OpenAI', source: 'openai', secret: 'OPENAI', defaultModel: 'gpt-5.1',
        models: ['gpt-5.2', 'gpt-5.1', 'gpt-5.1-chat-latest', 'gpt-4o', 'gpt-4o-mini'] },
    { id: 'claude', label: 'Claude (Anthropic)', source: 'claude', secret: 'CLAUDE', defaultModel: 'claude-sonnet-4-6',
        models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022'] },
    { id: 'google', label: 'Google Gemini (AI Studio)', source: 'makersuite', secret: 'MAKERSUITE', defaultModel: 'gemini-3.1-pro-preview',
        models: GEMINI },
    { id: 'vertexai', label: 'Google Vertex AI', source: 'vertexai', defaultModel: 'gemini-3.1-pro-preview',
        models: GEMINI },
    { id: 'openrouter', label: 'OpenRouter', source: 'openrouter', secret: 'OPENROUTER', defaultModel: 'google/gemini-3.1-pro-preview',
        models: [
            'google/gemini-3.1-pro-preview', 'google/gemini-3-pro-preview', 'google/gemini-3-flash-preview',
            'google/gemini-2.5-pro', 'google/gemini-2.5-flash',
            'anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5',
            'openai/gpt-5.2', 'openai/gpt-5.1', 'openai/gpt-4o',
            'deepseek/deepseek-chat-v3-5', 'deepseek/deepseek-r2',
        ] },
    { id: 'deepseek', label: 'DeepSeek', source: 'deepseek', secret: 'DEEPSEEK', defaultModel: 'deepseek-chat-v3-5',
        models: ['deepseek-chat-v3-5', 'deepseek-r2', 'deepseek-chat', 'deepseek-reasoner'] },
];
export const providerById = (id) => PROVIDERS.find(p => p.id === id);
/** Each provider's first model, as settings' last-used model per provider starts. */
export const defaultModels = () => Object.fromEntries(PROVIDERS.map(p => [p.id, p.defaultModel]));
