# Polyglot

A SillyTavern extension that turns your chats into language study.

### Main features

- **Annotation** — Highlight vocabulary by CEFR level and grammar in any character message
- **Translate & look up** — Double-click a sentence to translate it; select a word for its meaning
- **Whole-message translation** — Optional: a translation under each paragraph of character messages, on a button or for every new message; highlights stay on the original
- **Input assistant** — Fix or translate what you type before sending (🌍)
- **Wordbook & reviews** — Save words, review them on a spaced schedule; words you are learning are underlined in chat
- **Listen to dialogue** — ▶ after each line reads it aloud, in each character's voice; save lines to say after the voice
- **Study modes** — Flashcards, quizzes, writing practice, matching, dictation and shadowing
- **Pronunciation checks** — Optional, with your own key: Azure scores word by word, OpenAI transcription, and AI advice on your recording
- **Anki** — Import and export `.apkg` decks with sounds and pictures
- **Furigana** — Readings over kanji (Japanese)

### Setup

1. Extensions → **Install extension** → `https://github.com/FigCake/ST.Polyglot`
2. Extensions → **Polyglot**: set your study language, level and AI connection
3. Open the panel from 🌍 on a message or the 🧩 menu

Works with SillyTavern's own connection, a connection profile, or OpenAI, Claude, Gemini, DeepSeek, OpenRouter and other OpenAI-compatible APIs.

### Your data

Words are saved in `polyglot-data.json` in your SillyTavern user files and shared by every device that opens it. **Settings → Back up** saves everything to one file; API keys are never included.

### Other versions

- **[Marinara Engine](https://github.com/FigCake/ME.Polyglot)** — installed with Fetchy; uses Marinara's connections and voice
- **[Web app](https://github.com/FigCake/W.Polyglot)** — in the browser with its own chat, nothing to install

A backup made in one restores in the others.

### Requirements

SillyTavern 1.12.9 or newer (tested on 1.19.0). Pronunciation practice works in Chrome or Edge, or in any browser with an Azure or OpenAI key.

### Notices

Open-source licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Polyglot is not affiliated with Anki or SillyTavern, and includes no Anki code.
