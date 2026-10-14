# Polyglot

> An integrated language learning extension for SillyTavern that turns your chats into an active study environment.

---

### Features

- **Input Assistant** — Translate or check your input before sending (🌍 button): the grammar fix, then a more natural version under `---`, in the input box. Each check is kept in the correction archive (writing practice) with its explanation, for notes; the last 100 are kept
- **Annotation** — Highlight vocabulary by CEFR level and grammar patterns on any AI message
- **Leave out of study** — Status windows and metadata (tags such as `<status>`, code blocks, folded boxes, `[bracket]` lines) are not analysed, and character, persona and group-member names are never highlighted or saved as words; JS-Slash-Runner frontends and hidden text are always left out. Set in Extensions → Polyglot, with a check of what the last message sends
- **Tap to Translate** — Double-click a sentence (mouse), or select text and tap **Translate sentence** (touch), for an inline translation with verb forms; ask for a deeper sentence analysis from there
- **Quick Lookup** — Select any word to get its dictionary form, POS, IPA, and meaning
- **Wordbook + spaced review** — Save words and review them on an FSRS schedule: today's due words first, then new words up to a daily limit, with a forecast for the coming days. A word you have learnt comes back in turn as its meaning, its saved example with the word blanked out, or its meaning with the word to type. Each word is new, learning or known (recalled for three weeks, or marked known to leave the reviews), with a status filter; ignoring a word removes it and stops it being highlighted or saved again. Words you keep forgetting are marked as often missed, with a wordbook filter and a matching game of just those words. The Learn tab opens on your study record: day streak, today's work, reviews left, 30-day accuracy, this month's calendar with your runs of study days, and the reviews due this week. One shared wordbook, viewable per chat or across all chats, and per study language. Merge duplicates, fill missing meanings with AI re-analysis, organise words into sets
- **Import / Export** — Anki decks (`.apkg` / `.colpkg`, with sounds and images) in and out: the export is an `.apkg` with each word's meaning, example, note, sound and picture, tagged by level, set and status. Also CSV, and a TXT file for flashcard apps
- **Voice** — 🔊 reads words, examples and sentences with your browser's voice (free), SillyTavern's TTS extension (`/speak`), or a voice service you connect directly: ElevenLabs, Google Cloud Text-to-Speech, Fish Audio, or any OpenAI-compatible speech endpoint, local servers included. A sound made by a service is kept as the word's (or its example's) sound, so each one is paid for once and goes into flashcards and the Anki export. Words and examples whose sound is kept show a dot on 🔊; a *No sound* filter, *Make sounds* for selected words (only the missing ones, or remake the generated ones with a new voice — Anki recordings are kept) and Play / Make again / Remove in a word's edit form. Each word is read in its own language. Slower speeds for learning; services that refuse browser requests can go through SillyTavern's CORS proxy (`enableCorsProxy: true` in `config.yaml`) — not together with SillyTavern's login (`basicAuthMode`)
- **Furigana (Japanese)** — Readings over kanji with message analysis (📖) and on word cards, flashcards and the PDF deck; click a reading to correct it
- **Study Modes** — Flashcards, quiz, cloze, typed grammar gaps, reading exam, a weak-points exam built from saved wrong answers, conjugation drill, match, speaking
- **Writing practice** — Exam-style tasks at your CEFR level (letter or email, opinion text, a scene from your chat), rated on task, organisation, accuracy and range, with corrections and a model answer
- **PDF Export** — Print-ready A5 flashcard deck, with the conjugation tables you have opened at the end
- **Slash commands** — `/pg-check <text>` (or the input box's text, from Quick Replies and scripts), `/pg-annotate`, `/pg-lookup <word>`, `/pg-panel`
- **Themes** — Dark, light, breeze and milk; docked or floating panel

---

### Setup

1. In SillyTavern, open Extensions → **Install extension** and enter `https://github.com/FigCake/ST.Polyglot`
2. In SillyTavern → Extensions → **Polyglot**, set your target language, CEFR level, and AI provider
3. Open the Polyglot panel (🌍 on a message, or the 🧩 menu next to the input) for study, the wordbook, and display settings

Supports SillyTavern's default connection, a SillyTavern connection profile (Connection Manager; its preset is left out), or external APIs — OpenAI, Claude, Gemini, Vertex AI, DeepSeek, OpenRouter, and any OpenAI-compatible endpoint.

---

### Your data

- **Storage** — Your words live in `polyglot-data.json` in your SillyTavern user files (not in settings), so they follow you to every device that opens the same SillyTavern. Changes saved from two devices are combined, not overwritten. Changes not saved yet (a closed tab, a server that was down) are kept in the browser and saved at the next load. If your SillyTavern cannot store user files, words are kept in each chat instead, and the all-chats view and sounds/images are unavailable.
- **Backup** — Settings → Back up saves words, review progress, sets, saved wrong answers, settings and cached conjugation tables as one JSON file, or a `.zip` when words have sounds or images. API keys, the AI connection (provider, model, connection profile, Custom base URL) and where voice requests go (voice service, OpenAI-compatible URL, proxy) are never included.
- **Restore** — *Merge* adds a backup to your data; *Replace* swaps everything for it, after first downloading a backup of what you have now.

---

### Requirements

- SillyTavern 1.12.9 or newer (tested on 1.19.0). Connection profiles need 1.13.0 or newer
- AI provider with 8k+ context window recommended
- Chrome or Edge for pronunciation features (Web Speech API)

---

### Third-party notices

Open-source software used by Polyglot and its licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — also available in the panel
under **Settings → Open-source licenses**.

Anki and SillyTavern are names of their own projects. Polyglot is not affiliated
with or endorsed by either. The Anki import reads the `.apkg` / `.colpkg` file
format with Polyglot's own code, and the Anki export writes it (and the SQLite file
inside) the same way; no Anki code is included.
