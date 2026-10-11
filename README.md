# Polyglot

> An integrated language learning extension for SillyTavern that turns your chats into an active study environment.

---

### Features

- **Input Assistant** — Translate or grammar-check your input before sending (🌍 button)
- **Annotation** — Highlight vocabulary by CEFR level and grammar patterns on any AI message
- **Tap to Translate** — Double-click a sentence (mouse), or select text and tap **Translate sentence** (touch), for an inline translation with verb forms; ask for a deeper sentence analysis from there
- **Quick Lookup** — Select any word to get its dictionary form, POS, IPA, and meaning
- **Wordbook + SRS** — Save words and review them with SM-2 spaced repetition. One shared wordbook, viewable per chat or across all chats. Merge duplicates, fill missing meanings with AI re-analysis, organise words into sets
- **Import / Export** — Anki decks (`.apkg` / `.colpkg`, with sounds and images), CSV, and a TXT file for flashcard apps
- **Furigana (Japanese)** — Readings over kanji with message analysis (📖) and on word cards, flashcards and the PDF deck; click a reading to correct it
- **Study Modes** — Flashcards, quiz, cloze, reading exam, a weak-points exam built from saved wrong answers, conjugation drill, match, speaking
- **PDF Export** — Print-ready A5 flashcard deck, with the conjugation tables you have opened at the end
- **Slash commands** — `/pg-check`, `/pg-annotate`, `/pg-lookup <word>`, `/pg-panel`
- **Themes** — Dark, light, breeze and milk; docked or floating panel

---

### Setup

1. In SillyTavern, open Extensions → **Install extension** and enter `https://github.com/FigCake/ST.Polyglot`
2. In SillyTavern → Extensions → **Polyglot**, set your target language, CEFR level, and AI provider
3. Open the Polyglot panel (🌍 on a message, or the 🧩 menu next to the input) for study, the wordbook, and display settings

Supports SillyTavern's default connection or external APIs — OpenAI, Claude, Gemini, Vertex AI, DeepSeek, OpenRouter, and any OpenAI-compatible endpoint.

---

### Your data

- **Storage** — Your words live in `polyglot-data.json` in your SillyTavern user files (not in settings), so they follow you to every device that opens the same SillyTavern. Changes saved from two devices are combined, not overwritten. If your SillyTavern cannot store user files, words are kept in each chat instead, and the all-chats view and sounds/images are unavailable.
- **Backup** — Settings → Back up saves words, review progress, sets, saved wrong answers, settings and cached conjugation tables as one JSON file, or a `.zip` when words have sounds or images. API keys and the AI connection (provider, model, Custom base URL) are never included.
- **Restore** — *Merge* adds a backup to your data; *Replace* swaps everything for it, after first downloading a backup of what you have now.

---

### Requirements

- SillyTavern
- AI provider with 8k+ context window recommended
- Chrome or Edge for pronunciation features (Web Speech API)

---

### Third-party notices

Open-source software used by Polyglot and its licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — also available in the panel
under **Settings → Open-source licenses**.

Anki and SillyTavern are names of their own projects. Polyglot is not affiliated
with or endorsed by either. The Anki import reads the `.apkg` / `.colpkg` file
format with Polyglot's own code; no Anki code is included.
