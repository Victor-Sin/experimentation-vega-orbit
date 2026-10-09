import { $mediaStatus } from '@scripts/stores/deviceStatus.ts';

export const $device = {
    get: () => $mediaStatus.get()
};
