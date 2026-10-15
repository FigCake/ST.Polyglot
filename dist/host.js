// Where Polyglot is running, for the few things only SillyTavern has. This is
// SillyTavern's; the web app and the Marinara extension build swap in
// hosts/common/host.ts (hosts/vite-host.ts), so code asks HOST instead of
// assuming SillyTavern.
//
//   stConnection   SillyTavern's own connection, its connection profiles and Vertex AI (requests through its server)
//   stVoice        SillyTavern's TTS extension and its CORS proxy
//   ownKeys        API keys are entered in Polyglot and requests go straight from the browser
//                  (in SillyTavern its server sends them with the keys stored there)
//   version()      Polyglot's version (here: the manifest next to the extension)
//   notices()      the third-party notices (here: the copy in dist/)
//   ai             the app's own AI connections and voice service Polyglot can use (Marinara's); none here
export const HOST = {
    id: 'sillytavern',
    stConnection: true,
    stVoice: true,
    ownKeys: false,
    ai: null,
    // dist/host.js sits in dist/, the manifest one folder up
    version: async () => String((await (await fetch(new URL('../manifest.json', import.meta.url), { cache: 'no-store' })).json()).version ?? '?'),
    notices: async () => {
        const res = await fetch(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url));
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return res.text();
    },
};
