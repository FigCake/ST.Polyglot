// What the sound tools say when sounds cannot be made (sound-maker.soundsBlocked).
// Shared by "Make sounds" (sound-bar.ts) and the edit form (wordbook/sound-rows.ts).
import { t } from '../i18n.js';
import { notify } from '../ui.manager.js';
import { soundsBlocked } from '../sound-maker.js';
const BLOCK_NOTICE = {
    service: 'snd.needService',
    key: 'snd.needKey',
    voice: 'snd.needVoice',
    storage: 'snd.needStorage',
};
/** True when sounds can be made now; otherwise says why. */
export function checkSoundsReady() {
    const block = soundsBlocked();
    if (block)
        notify(t(BLOCK_NOTICE[block]), 'warn', 4000);
    return !block;
}
