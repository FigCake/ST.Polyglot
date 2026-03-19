// ════════════════════════════
// Polyglot  prompts.ts
// ════════════════════════════
// All AI prompt-builder functions.
// Pure string functions — no side effects, no DOM, no API calls.
// Dependencies: none (nativeLang is passed in as a resolved string by callers).
// ── Language helpers ──────────────────────────────────────────────────────────
/**
 * Returns language-specific instructions for extracting the base form of a word.
 * Used inside annotatorPrompt and quickLookupPrompt.
 */
export function baseFormRule(lang) {
    const l = lang.toLowerCase();
    if (['spanish', 'espanol', 'español', 'portuguese', 'português'].some(x => l.includes(x)))
        return 'dictionary form — verbs as infinitive (e.g. "hablar"/"falar"), nouns with definite article (e.g. "el libro"/"o livro", "la casa"/"a casa"), adjectives in masculine singular (e.g. "alto")';
    if (['italian', 'italiano'].some(x => l.includes(x)))
        return 'dictionary form — verbs as infinitive (e.g. "parlare"), nouns with definite article (e.g. "il gatto", "la porta"), adjectives in masculine singular (e.g. "bello")';
    if (['french', 'français', 'francais'].some(x => l.includes(x)))
        return 'dictionary form — verbs as infinitive (e.g. "parler"), nouns with definite article (e.g. "le livre", "la maison"), adjectives in masculine singular (e.g. "grand")';
    if (['german', 'deutsch'].some(x => l.includes(x)))
        return 'dictionary form — verbs as infinitive (e.g. "sprechen"), nouns with definite article and capitalized (e.g. "der Hund", "die Katze", "das Haus")';
    if (['japanese', '日本語'].some(x => l.includes(x)))
        return 'dictionary form — verbs in plain form (e.g. "話す"), nouns as-is (e.g. "本"), i-adjectives in plain form (e.g. "高い")';
    if (['chinese', '中文', '普通话'].some(x => l.includes(x)))
        return 'the word in its standard simplified Chinese form, no conjugation needed';
    if (['korean', '한국어'].some(x => l.includes(x)))
        return 'dictionary form — verbs/adjectives ending in 다 (e.g. "먹다", "예쁘다"), nouns as-is';
    return 'dictionary/infinitive form — verbs as base infinitive (e.g. "run", not "ran"), nouns in singular (e.g. "book"), adjectives in base form (e.g. "good")';
}
// ── Prompt builders ───────────────────────────────────────────────────────────
/**
 * @param text       Text to check / translate
 * @param lang       Learning language (e.g. "Spanish")
 * @param level      CEFR level (e.g. "B1")
 * @param nativeLang User's native language name (e.g. "English", "Spanish")
 */
export function checkerPrompt(text, lang, level, nativeLang) {
    return `You are a ${lang} language tutor for CEFR ${level} learners.
The user wants to express something in ${lang}.

Instructions:
- Detect the language of the input text.
- If the input IS already in ${lang}: fix only spelling, grammar, and unnatural phrasing. Do not rephrase what is already correct.
- If the input is in ANY OTHER language: translate it naturally into ${lang} at CEFR ${level} level, then apply corrections.
- The final "corrected_text" must always be in ${lang}.

Return ONLY valid JSON (no markdown, no extra text):
{ "corrected_text": "...", "explanation": "..." }

- "corrected_text": the final ${lang} text (translated if needed, then corrected)
- "explanation": brief explanation in ${nativeLang} — if translated, say which language was detected and what was changed; if only corrected, describe the corrections; if nothing changed, say "no change"

Text:
<text>${text}</text>`;
}
/**
 * @param text       Message text to annotate
 * @param lang       Learning language (e.g. "Spanish")
 * @param level      CEFR level (e.g. "B1")
 * @param nativeLang User's native language name (e.g. "English", "Spanish")
 */
export function annotatorPrompt(text, lang, level, nativeLang) {
    const rule = baseFormRule(lang);
    return `You are a meticulous language tutor. Analyze the following ${lang} text for a CEFR ${level} learner.
IMPORTANT: Analyze the ENTIRE text. Identify AT LEAST 30 items if the text is long enough.

Task 1: Words/verbs/adjectives/phrases harder than or equal to ${level}.
- "word": exact word/phrase as it appears in text
- "base_form": ${rule}
- "pos_info": tense/gender/number/form info in ${nativeLang}
- "meaning": dictionary meaning of the BASE FORM in ${nativeLang}
- "context_meaning": meaning of THIS SPECIFIC WORD as used in this sentence in ${nativeLang}
- "level": A1-C2

Task 2: Key grammar patterns.
- "pattern": exact substring
- "meaning": meaning in ${nativeLang}
- "structure": grammar rule explanation in ${nativeLang}
- "words_used": breakdown

Task 3: Idioms, fixed expressions, and notable collocations.
Identify multi-word expressions that a learner should memorise as a whole unit.
- "phrase": exact phrase as it appears in text (2+ words)
- "base_form": canonical/dictionary form of the phrase
- "meaning": meaning of the whole expression in ${nativeLang}
- "context_meaning": how it is used in this specific context in ${nativeLang}
Include: idioms (e.g. "estar en las nubes"), verb+preposition units (e.g. "depender de"),
         fixed collocations (e.g. "hacer una pregunta"), and discourse markers.
Exclude single words already covered in Task 1.

Return ONLY:
{
  "hard_words": [{ "word":"","base_form":"","pos_info":"","meaning":"","context_meaning":"","level":"" }],
  "grammar_patterns": [{ "pattern":"","meaning":"","structure":"","words_used":"" }],
  "idioms": [{ "phrase":"","base_form":"","meaning":"","context_meaning":"" }]
}
Text:
<text>${text}</text>`;
}
/**
 * Generates N multiple-choice questions from recent chat history.
 * @param chatHistory  Recent chat messages joined as a string
 * @param lang         Learning language
 * @param level        CEFR level
 * @param nativeLang   User's native language name
 * @param questionCount Number of questions to generate (default 5)
 */
export function quizPrompt(chatHistory, lang, level, nativeLang, questionCount = 5) {
    const types = questionCount <= 5
        ? `Cover ALL of these types (one each):
  1. "vocab"   — word meaning or synonym/antonym
  2. "verb"    — conjugation, tense, mood, or verb form
  3. "grammar" — preposition, article, agreement, connective, or word order
  4. "idiom"   — fixed expression, collocation, or idiomatic usage
  5. "reading" — comprehension: what does a specific sentence/phrase mean in context?`
        : `Distribute questions across these types:
  - "vocab"   — word meaning, synonym/antonym (≈4 questions)
  - "verb"    — conjugation, tense, mood, aspect, irregular forms (≈5 questions)
  - "grammar" — preposition, article, agreement, word order, connectives (≈5 questions)
  - "idiom"   — fixed expression, collocation, idiomatic usage (≈3 questions)
  - "reading" — comprehension: meaning of a phrase/sentence in context (≈3 questions)`;
    return `You are an expert ${lang} language tutor creating a diagnostic quiz for a CEFR ${level} learner.
Create exactly ${questionCount} multiple-choice questions based ONLY on the text below.
${types}

Rules:
- Each question MUST reference actual words or sentences from the text.
- Distractors must be plausible but clearly wrong.
- question: ask in ${nativeLang}.
- explanation: explain WHY the answer is correct and why the others are wrong (${nativeLang}, 2-3 sentences).

Return ONLY:
{
  "questions": [
    {
      "type": "vocab|verb|grammar|idiom|reading",
      "question": "...",
      "options": ["A", "B", "C", "D"],
      "answer": "correct answer text (must match one option exactly)",
      "explanation": "..."
    }
  ]
}

Text:
<text>${chatHistory}</text>`;
}
/**
 * Cloze (fill-in-the-blank) quiz — CEFR-level based, independent of chat history.
 * Targets prepositions, verb conjugations, and idioms with 20 questions.
 */
export function clozeQuizPrompt(lang, level, nativeLang) {
    return `You are an expert ${lang} language tutor. Create exactly 20 fill-in-the-blank questions for a CEFR ${level} learner whose native language is ${nativeLang}.

Focus EXCLUSIVELY on these three categories (distribute evenly, ~7 each):
  1. "preposition" — choosing the correct preposition or prepositional phrase
  2. "verb"        — correct conjugation/tense/mood/aspect of a given verb
  3. "idiom"       — completing a fixed expression or collocation

Each question presents a natural ${lang} sentence with one blank (___), and four options.
Pitch difficulty precisely at CEFR ${level}. Do NOT base questions on any specific text.

Rules:
- question: the ${lang} sentence with ___ for the blank.
  Add a brief ${nativeLang} hint in parentheses when helpful (e.g. "(infinitive: essere)").
- options: four choices in ${lang}. Distractors must be plausible but clearly wrong.
- answer: must match one option exactly.
- explanation: grammar rule or idiom explanation in ${nativeLang}, 2 sentences.

Return ONLY valid JSON:
{
  "questions": [
    {
      "type": "preposition|verb|idiom",
      "question": "${lang} sentence with ___",
      "options": ["A", "B", "C", "D"],
      "answer": "correct option text",
      "explanation": "..."
    }
  ]
}`;
}
/**
 * Reading comprehension half mock exam — CEFR-level based, independent of chat history.
 * Modelled after real language proficiency tests (DELE, DALF, JLPT, Goethe, etc.)
 * Contains 25 questions across two sections.
 */
export function readingExamPrompt(lang, level, nativeLang) {
    return `You are an expert ${lang} language examiner. Create a half-length mock reading exam for a CEFR ${level} learner whose native language is ${nativeLang}.

The exam must contain exactly 25 questions in two sections:

SECTION A — Vocabulary & Grammar (10 questions, type: "grammar" or "vocab")
  - Sentence-completion and error-correction items at CEFR ${level} difficulty.
  - Each item is a standalone sentence. Set "passage" to null for all Section A items.

SECTION B — Reading Comprehension (15 questions, type: "reading")
  - Write ONE original ${lang} reading passage of 180-220 words at CEFR ${level} level.
  - Set "passage" to this text on EVERY Section B question (same string, repeated).
  - Questions test: main idea, specific detail, vocabulary in context, inference, author attitude.

All questions must be original — do NOT copy from real exams.
Pitch difficulty precisely at CEFR ${level}: not easier, not harder.

Rules:
- question: write in ${nativeLang} but keep ${lang} quotes/terms as-is.
- options: four choices. Section B options may be full sentences in ${nativeLang}.
- answer: must match one option exactly.
- explanation: ${nativeLang}, 2 sentences explaining why the answer is correct.

Return ONLY valid JSON:
{
  "questions": [
    {
      "type": "grammar|vocab|reading",
      "passage": null,
      "question": "...",
      "options": ["A", "B", "C", "D"],
      "answer": "correct option text",
      "explanation": "..."
    }
  ]
}

For Section B questions set "passage" to the reading text. For Section A set "passage" to null.`;
}
/**
 * @param word       Word to look up
 * @param context    Surrounding sentence (may be empty)
 * @param lang       Learning language
 * @param level      CEFR level
 * @param nativeLang User's native language name
 */
export function quickLookupPrompt(word, context, lang, level, nativeLang) {
    const rule = baseFormRule(lang);
    return `You are a language tutor for ${lang} learners at CEFR level ${level}.
Analyze: "${word}"
${context ? `Context: "${context}"` : ''}
- "word": the word as given
- "base_form": ${rule}
- "pos_info": tense/gender/number info in ${nativeLang}
- "meaning": dictionary meaning of the BASE FORM in ${nativeLang}
- "context_meaning": meaning of this word in the given context in ${nativeLang}. If no context, same as meaning.
- "level": A1|A2|B1|B2|C1|C2
- "word_family": array of up to 3 closely related forms from the same root/family.
  Each item: { "form": "...", "pos": "<one of: verb|noun|adj|adv|phrase>", "meaning": "<1-3 words in ${nativeLang}>" }
  Examples: for "bellezza" (noun) → [{"form":"bello","pos":"adj","meaning":"beautiful"},{"form":"abbellire","pos":"verb","meaning":"to beautify"}]
  Empty array [] if the word has no notable family members or is already a base form with no derivatives.
Return ONLY:
{
  "word": "...",
  "base_form": "...",
  "pos_info": "...",
  "meaning": "...",
  "context_meaning": "...",
  "level": "A1|A2|B1|B2|C1|C2",
  "word_family": [{ "form": "...", "pos": "...", "meaning": "..." }]
}`;
}
/**
 * Tap-to-translate: natural + literal translation of a full sentence.
 * @param sentence   Sentence to translate
 * @param lang       Source language (the learning language)
 * @param nativeLang Target language (the user's native language)
 */
export function tapTranslatePrompt(sentence, lang, nativeLang) {
    return `You are a ${lang}-to-${nativeLang} translation assistant.
Translate the following ${lang} sentence for a ${nativeLang} learner.

Rules:
- "translation": natural ${nativeLang} translation of the ENTIRE sentence
- "literal": more literal, word-by-word ${nativeLang} rendering that preserves the original word order as much as possible
- "key_verbs": array of the main verbs/phrases worth noting — each with:
    "form": exact form in the sentence
    "base": dictionary/infinitive form
    "meaning": ${nativeLang} meaning of the BASE form (1-3 words)
    "level": CEFR level of the BASE form ("A1","A2","B1","B2","C1","C2")
  Maximum 3 items. Empty array [] if none notable.

Return ONLY valid JSON:
{
  "translation": "...",
  "literal": "...",
  "key_verbs": [{ "form": "...", "base": "...", "meaning": "...", "level": "..." }]
}

Sentence: "${sentence}"`;
}
/**
 * Conjugation table prompt.
 * @param base       Dictionary/infinitive form of the verb
 * @param lang       Learning language
 * @param nativeLang User's native language name (for translation and tense labels)
 */
export function verbConjugationPrompt(base, lang, nativeLang) {
    return `You are a ${lang} grammar expert.
Generate a conjugation table for the ${lang} verb: "${base}"

Rules:
- "base": the dictionary/infinitive form
- "translation": meaning of the verb in ${nativeLang} (1–3 words)
- "tenses": exactly 3 tenses — choose the 3 MOST IMPORTANT/COMMON tenses for ${lang} learners
  (e.g. for Italian: Presente / Passato Prossimo / Imperfetto;
        for Spanish: Presente / Pretérito Indefinido / Imperfecto;
        for French: Présent / Passé Composé / Imparfait;
        for German: Präsens / Perfekt / Präteritum;
        for Japanese: 辞書形/ます形/て形 — use 6 rows labeled 肯定/否定/丁寧肯定/丁寧否定/て形/た形;
        for English: Present Simple / Past Simple / Future (will))
- Each tense has "name" (original language name), "name_native" (label in ${nativeLang}), and "rows"
- "rows": exactly 6 items with "person" label and "form" (the conjugated form)

Return ONLY valid JSON — no preamble, no fences:
{
  "base": "...",
  "translation": "...",
  "tenses": [
    {
      "name": "...",
      "name_native": "...",
      "rows": [
        { "person": "...", "form": "..." },
        { "person": "...", "form": "..." },
        { "person": "...", "form": "..." },
        { "person": "...", "form": "..." },
        { "person": "...", "form": "..." },
        { "person": "...", "form": "..." }
      ]
    }
  ]
}`;
}
/**
 * Generates a short, natural example sentence for a flashcard.
 * @param word       Base/dictionary form of the word
 * @param lang       Target learning language
 * @param level      CEFR level (controls sentence difficulty)
 * @param nativeLang User's native language (for the optional translation)
 */
export function exampleSentencePrompt(word, lang, level, nativeLang) {
    return `Create a short example sentence in ${lang} for a CEFR ${level} learner using the word "${word}".

Rules:
- "sentence": one clear, natural ${lang} sentence (max 12 words) showing typical usage
- "translation": natural ${nativeLang} translation of that sentence
- Difficulty should match CEFR ${level}

Return ONLY valid JSON (no markdown, no extra text):
{ "sentence": "...", "translation": "..." }`;
}
/**
 * Deep Analysis prompt — full syntactic breakdown of a sentence.
 * Language-neutral: works for any learning language.
 * Returns dependency-annotated tokens, grammar point explanations, and a summary.
 *
 * @param sentence   The sentence to analyse (as it appears in the chat)
 * @param lang       Learning language (e.g. "Italian", "Spanish", "Japanese", "German")
 * @param nativeLang User's native language (e.g. "English", "Spanish")
 */
export function deepAnalysisPrompt(sentence, lang, nativeLang) {
    return `You are an expert ${lang} grammar tutor. Perform a deep syntactic and dependency analysis of the following ${lang} sentence for a language learner whose native language is ${nativeLang}.

Sentence: "${sentence}"

Return ONLY valid JSON — no preamble, no markdown fences:
{
  "sentence": "...",
  "tokens": [
    {
      "text": "exact word or clitic as it appears",
      "role": "<role — see allowed values below>",
      "label": "<role name in ${nativeLang}, e.g. 주어/Subject/Soggetto/Sujeto>",
      "note": "<optional: tense/mood/case/agreement or WHY this form is used — ${nativeLang}, ≤20 words>",
      "head_idx": <0-based index of the token this token depends on; -1 for the root verb>,
      "dep_label": "<dependency relation in ${nativeLang}, e.g. 수식/목적/주어/보조/전치>"
    }
  ],
  "grammar": [
    {
      "point": "<grammar feature name in ${lang}>",
      "explanation": "<why it appears here and what triggers it — ${nativeLang}, 1-2 sentences>"
    }
  ],
  "summary": "<one sentence in ${nativeLang}: what makes this sentence structurally interesting for a learner>"
}

─── TOKEN RULES ───────────────────────────────────────────────────────────────
1. Cover EVERY surface token in order — do NOT skip articles, particles, clitics, or punctuation.
2. "role" must be exactly one of:
   subject | verb | auxiliary | object | complement | modifier | conjunction |
   particle | article | preposition | pronoun | punctuation | other
3. Language-specific guidance:
   • Romance (Italian/Spanish/French/Portuguese):
     - Pronominal clitics attached to a verb (e.g. "glielo", "se lo") → each clitic is its own token.
     - Contracted preposition+article (del, al, nel…) → one token, role "preposition".
     - Subjunctive/congiuntivo: note the trigger verb/conjunction in "note".
     - Compound tenses: auxiliary (essere/avoir/ser/haber) gets role "auxiliary", past participle gets role "verb".
   • German/Dutch:
     - Separable verb prefix in split position → own token, head_idx points to the base verb.
     - Dative/accusative case on articles and adjectives → note the case in "note".
   • Japanese/Korean:
     - Every postpositional particle (は/が/を/에/을…) → role "particle", head_idx points to the noun it marks.
   • Arabic/Hebrew (RTL):
     - Treat tokens left-to-right by logical order (index 0 = first word in reading order).
   • Any language with agreement (gender/number/person): flag mismatches or notable patterns in "note".
4. head_idx: the ROOT verb's head_idx is -1. Every other token points to the token it most directly depends on.
   Modifiers point to the noun they modify. Objects/subjects point to the verb. Auxiliaries point to the main verb.
5. dep_label: use a short ${nativeLang} word. Examples: 수식(modify)/보조(auxiliary)/주어(subject)/목적(object)/전치(preposition)/접속(conjunction)/서술(predicate).

─── GRAMMAR RULES ─────────────────────────────────────────────────────────────
- Include 1–3 entries. Prioritise features that are genuinely tricky for learners.
- Always flag (when present): subjunctive/mood triggers, compound/perfect tenses,
  pronoun placement or agreement, word-order inversions, case marking, particle choice,
  aspect/tense distinctions, politeness level (Japanese/Korean).
- "point": name the feature in ${lang} (not in ${nativeLang}).
- "explanation": concrete, learner-focused, written in ${nativeLang}.`;
}
/**
 * Batch reanalysis — analyses up to BATCH_SIZE words in a single API call.
 * Returns a JSON array in the same order as the input words.
 */
export function batchReanalysisPrompt(words, lang, nativeLang) {
    const wordList = words
        .map((w, i) => `${i + 1}. word: "${w.word}", base_form: "${w.base_form}"`)
        .join('\n');
    return `You are a precise ${lang} linguistics assistant.
Analyse the following ${lang} words for a language learner.

${wordList}

Return ONLY a valid JSON array — no preamble, no markdown fences.
One object per word, in the same order, each with these fields:
{
  "word": "<surface form as given>",
  "base_form_verified": "...",
  "pos": "...",
  "pos_label": "...",
  "ipa": "...",
  "collocations": ["...", "..."]
}

Field rules (apply to EVERY word):
- "word": copy the surface form exactly as provided.
- "base_form_verified": correct dictionary/infinitive form.
    If stored base_form is already correct, return it unchanged.
    Use the format standard for ${lang}
    (e.g. Italian nouns with article: "il gatto"; verbs as infinitive: "parlare").
- "pos": EXACTLY one of: verb | noun | adj | adv | phrase | particle | conj | prep | num | interj | article
    For idioms or fixed expressions use "phrase".
- "pos_label": short ${nativeLang} label for POS (e.g. "verbo" for Spanish, "동사" for Korean). 1–2 words max.
- "ipa": IPA pronunciation string.
    • English, French, German — always provide IPA.
    • Italian, Spanish, Portuguese — return "".
    • Japanese — return hiragana reading (e.g. "はなす").
    • Korean — return "".
    • Chinese — return pinyin with tones (e.g. "shuō huà").
    • Other — provide IPA only if pronunciation is irregular, else "".
- "collocations": up to 4 short usage patterns or key collocations that help a learner use the word correctly.
    Examples for a verb: ["dipendere da qc/qn", "non dipende da me — 나에게 달려있지 않다"]
    Examples for a noun: ["fare una domanda", "rispondere a una domanda"]
    If there are no notable collocations, return [].
    Each string: max 40 characters. ${nativeLang} glosses allowed after " — ".`;
}
/**
 * Single-word re-analysis — enriches an existing wordbook entry with
 * POS tag, IPA, and collocations without touching user-owned fields
 * (meaning, notes, srs_*, setIds).
 * Used as fallback when batch reanalysis fails to parse.
 *
 * @param word       Surface/display form of the word as stored
 * @param base_form  Current stored base/dictionary form
 * @param lang       Learning language (e.g. "Italian")
 * @param nativeLang User's native language name (e.g. "English", "Spanish")
 */
export function reanalysisPrompt(word, base_form, lang, nativeLang) {
    return `You are a precise ${lang} linguistics assistant.
Analyse the following ${lang} word for a language learner.

Word (surface form): "${word}"
Stored base form: "${base_form}"

Return ONLY valid JSON — no preamble, no markdown fences:
{
  "base_form_verified": "...",
  "pos": "...",
  "pos_label": "...",
  "ipa": "...",
  "collocations": ["...", "..."]
}

Field rules:
- "base_form_verified": correct dictionary/infinitive form.
    If the stored base_form is already correct, return it unchanged.
    Use the same format as baseFormRule for ${lang}
    (e.g. Italian nouns with article: "il gatto"; verbs as infinitive: "parlare").
- "pos": EXACTLY one of these tags (no other values allowed):
    verb | noun | adj | adv | phrase | particle | conj | prep | num | interj | article
    For idioms or fixed expressions: use "phrase".
- "pos_label": short ${nativeLang} label for the POS (e.g. "verbo", "sustantivo" for Spanish; "동사", "명사" for Korean;
    "verbo", "sostantivo" for Italian). 1–2 words maximum.
- "ipa": IPA pronunciation string (e.g. "/ˈpɑːrlər/").
    Rules by language:
    • English — always provide IPA (pronunciation is irregular).
    • French  — always provide IPA.
    • German  — provide IPA.
    • Italian, Spanish, Portuguese — omit (spelling is phonetic); return "".
    • Japanese — return the reading in hiragana instead of IPA (e.g. "はなす").
    • Korean   — return "" (pronunciation follows spelling rules).
    • Chinese  — return pinyin with tones (e.g. "shuō huà").
    • Other languages — provide IPA if pronunciation is irregular; otherwise "".
- "collocations": array of up to 4 short usage patterns or key collocations
    that help a learner use this word correctly.
    Examples for a verb: ["dipendere da qc/qn", "non dipende da me"]
    Examples for a noun: ["fare una domanda", "rispondere a una domanda"]
    Examples for an adjective: ["essere + ${word}", "${word} + noun (agreement)"]
    If there are no notable collocations, return [].
    Each string: max 40 characters. ${nativeLang} glosses allowed after " — ".`;
}
/**
 * Generates a conjugation drill quiz from cached conjugation table data.
 * The caller passes the full ConjData JSON as a string.
 * @param conjJson   JSON string of ConjData (base, tenses with rows)
 * @param lang       Learning language
 * @param nativeLang User's native language
 * @param count      Number of questions to generate (default 10)
 */
export function conjDrillPrompt(conjJson, lang, nativeLang, count = 10) {
    return `You are a ${lang} grammar drill coach.
Using the conjugation table below, generate exactly ${count} multiple-choice questions testing the learner's knowledge of verb forms.

Conjugation data (JSON):
${conjJson}

Rules:
- Each question asks for the correct conjugated form given a person + tense.
- "question": e.g. "io / Presente → ?" or "they / Past → ?" — use the person label from the table.
- "options": 4 choices — 1 correct form + 3 plausible distractors from OTHER cells in the table.
- "answer": the exact correct form string.
- "explanation": one sentence in ${nativeLang} explaining the form or any irregularity.
- "type": always "verb".
- Vary the tenses and persons — do NOT repeat the same cell twice.

Return ONLY valid JSON — no preamble, no fences:
{
  "questions": [
    { "type": "verb", "question": "...", "options": ["...","...","...","..."], "answer": "...", "explanation": "..." }
  ]
}`;
}
/**
 * Generates a targeted exam from saved wrong answers.
 * Each wrong answer produces 2 new similar questions of the same type.
 * @param wrongAnswers  Array of WrongAnswer objects (max 5)
 * @param lang          Learning language
 * @param nativeLang    User's native language
 */
export function targetedExamPrompt(wrongAnswers, lang, nativeLang) {
    const items = wrongAnswers.map((w, i) => `${i + 1}. [type: ${w.type}] Q: "${w.question}" | Correct answer: "${w.answer}" | Rule: "${w.explanation}"`).join('\n');
    return `You are a ${lang} language tutor creating a targeted remedial exam.
The learner previously got these questions WRONG:

${items}

For each wrong answer, generate 2 NEW questions targeting the SAME linguistic weakness:
- For "vocab" type: use the same word in a different example sentence (fill-in-the-blank or meaning).
- For "verb" type: test the same verb form or tense pattern with a different verb or person.
- For "grammar" type: test the same grammar rule (agreement, preposition, article, word order) in a new context.
- For "idiom" type: test the same fixed expression or a closely related collocation.
- For "reading" type: create a new short passage testing the same comprehension skill.

Rules:
- Total questions: exactly ${wrongAnswers.length * 2}.
- "type": same as the source wrong answer.
- "options": 4 choices — 1 correct + 3 plausible distractors.
- "explanation": 1–2 sentences in ${nativeLang} explaining the rule tested.
- Do NOT reuse the exact original question text.

Return ONLY valid JSON — no preamble, no fences:
{
  "questions": [
    { "type": "...", "question": "...", "options": ["...","...","...","..."], "answer": "...", "explanation": "..." }
  ]
}`;
}
