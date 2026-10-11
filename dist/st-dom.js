// SillyTavern's chat markup, which Polyglot reads but does not own. Every
// selector that depends on ST's HTML lives here, so if ST renames a class
// or attribute only this file changes. Polyglot's own elements (pg-*) are
// named where they are built.
export const ST_SEL = {
    chat: '#chat',
    mes: '.mes',
    mesText: '.mes_text',
    /** Messages written by the AI (ST marks them is_user="false"). */
    aiMes: '.mes[is_user="false"]',
    /** A message's extra button row, where the 📖 and 🌍 buttons go. */
    extraMesButtons: '.extraMesButtons',
    sendBtn: '#send_but',
    sendTextarea: '#send_textarea',
    /** The 🧩 dropdown left of the input bar. */
    extensionsMenu: '#extensionsMenu',
    /** The Extensions settings drawer. */
    extensionsSettings: '#extensions_settings',
};
/** Selector for the message with this id. */
export const mesSelector = (mesId) => `${ST_SEL.mes}[mesid="${CSS.escape(mesId)}"]`;
/** The text element of the message with this id, if it is rendered. */
export const mesTextOf = (mesId) => document.querySelector(`${mesSelector(mesId)} ${ST_SEL.mesText}`);
/** The id of the message containing `el`, if any. */
export const mesIdOf = (el) => el?.closest(ST_SEL.mes)?.getAttribute('mesid') ?? null;
