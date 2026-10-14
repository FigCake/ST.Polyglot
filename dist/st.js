// SillyTavern's runtime: the only module that imports it, typed by
// types/st-stubs.d.ts. Other files directly in src/ import from here; files
// in subfolders through runtime.ts (st-imports.test.ts keeps it that way).
//
// ST's modules are imported by paths relative to the built file (dist/st.js
// sits where ST's third-party extensions are loaded from); TypeScript cannot
// resolve them, so each import is untyped and given its stub's type here.
// A wrong field name on getContext() etc. is now a compile error.
// @ts-expect-error — ST runtime module (untyped here; typed below)
import * as script from '../../../../../script.js';
// @ts-expect-error — ST runtime module
import * as extensions from '../../../../extensions.js';
// @ts-expect-error — ST runtime module
import * as secrets from '../../../../secrets.js';
// @ts-expect-error — ST runtime module
import * as parser from '../../../../slash-commands/SlashCommandParser.js';
// @ts-expect-error — ST runtime module
import * as command from '../../../../slash-commands/SlashCommand.js';
// @ts-expect-error — ST runtime module
import * as argument from '../../../../slash-commands/SlashCommandArgument.js';
export const getRequestHeaders = script.getRequestHeaders;
export const saveSettingsDebounced = script.saveSettingsDebounced;
export const eventSource = script.eventSource;
export const event_types = script.event_types;
export const getContext = extensions.getContext;
export const extension_settings = extensions.extension_settings;
export const saveMetadataDebounced = extensions.saveMetadataDebounced;
export const SECRET_KEYS = secrets.SECRET_KEYS;
export const secret_state = secrets.secret_state;
export const SlashCommandParser = parser.SlashCommandParser;
export const SlashCommand = command.SlashCommand;
export const SlashCommandNamedArgument = argument.SlashCommandNamedArgument;
export const ARGUMENT_TYPE = argument.ARGUMENT_TYPE;
