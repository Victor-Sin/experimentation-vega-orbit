import { clamp } from '#utils/maths.ts';

import type { CanvasComponent } from './CanvasComponent.ts';

export interface PixelManagerParameters {
    preset?: PixelPreset;
    defaultCount?: number;
    minRatio?: number;
    maxRatio?: number;
}

export interface PixelManagerEventMap {
    onMinRatioChange: { value: number };
    onMaxRatioChange: { value: number };
    onMaxCountChange: { value: number };
    onCurrentRatioChange: { value: number };
}

type EventName = keyof PixelManagerEventMap;
type EventListener<T extends EventName> = (detail: PixelManagerEventMap[T]) => void;
type ListenerMap = { [K in EventName]: Array<EventListener<K>> };

// Isolate listener errors so one throwing cb can't abort the rest of an emit.
// Logs through the owning component's logger (id-prefixed) when attached.
function run<T extends EventName>(
    cb: EventListener<T>,
    detail: PixelManagerEventMap[T],
    logError: (...args: unknown[]) => void
): void {
    try {
        cb(detail);
    } catch (err) {
        logError(`PixelManager listener threw:`, err);
    }
}

type QualityPreset = '360p' | '480p' | '720p' | '1080p' | '1440p' | '4k' | '8k';

export type PixelPreset = Record<QualityPreset, number>;

export const PIXEL_PRESETS: PixelPreset = {
    '360p': 640 * 360,
    '480p': 854 * 480,
    '720p': 1280 * 720,
    '1080p': 1920 * 1080,
    '1440p': 2560 * 1440,
    '4k': 3840 * 2160,
    '8k': 7680 * 4320
};

export class PixelManager {
    public readonly component: CanvasComponent;

    private minRatio: number = 1;
    private maxRatio: number = 2;
    private currentRatio: number = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    private maxCount: number = PIXEL_PRESETS['4k'];
    private readonly preset: PixelPreset = PIXEL_PRESETS;

    private readonly listeners: ListenerMap = {
        onMinRatioChange: [],
        onMaxRatioChange: [],
        onMaxCountChange: [],
        onCurrentRatioChange: []
    };

    constructor(
        component: CanvasComponent,
        { preset, defaultCount, minRatio, maxRatio }: Partial<PixelManagerParameters> = {}
    ) {
        this.component = component;
        this.preset = preset ?? this.preset;
        this.minRatio = minRatio ?? this.minRatio;
        this.maxRatio = maxRatio ?? this.maxRatio;
        this.setMaxCount(defaultCount ?? this.maxCount);
    }

    public on<T extends EventName>(eventType: T, listener: EventListener<T>): () => void {
        this.listeners[eventType].push(listener);
        return () => {
            const arr = this.listeners[eventType] as Array<EventListener<T>>;
            const i = arr.indexOf(listener);
            if (i !== -1) arr.splice(i, 1);
        };
    }

    public setMinRatio(v: number) {
        if (this.minRatio === v) return;
        this.minRatio = v;
        this.emit('onMinRatioChange', { value: v });
    }

    public setMaxRatio(v: number) {
        if (this.maxRatio === v) return;
        this.maxRatio = v;
        this.emit('onMaxRatioChange', { value: v });
    }

    public setMaxCount(v: number | string) {
        if (v == null) v = 0;
        if (typeof v === 'string') {
            const preset = this.preset[v.toLowerCase() as QualityPreset];
            if (preset === undefined) {
                console.warn(
                    `[PixelManager] Unknown preset "${v}" — pixel budget cap disabled (0).`
                );
                v = 0;
            } else {
                v = preset;
            }
        }
        if (this.maxCount === v) return;
        this.maxCount = v;
        this.emit('onMaxCountChange', { value: v });
    }

    public setCurrentRatio(v: number) {
        if (this.currentRatio === v) return;
        this.currentRatio = v;
        this.emit('onCurrentRatioChange', { value: v });
    }

    public computeDPR(width: number, height: number, dpr: number): number {
        let pixelRatio = clamp(dpr, this.getMinRatio(), this.getMaxRatio());
        const pixelCount = Math.floor(width * pixelRatio * height * pixelRatio);
        const maxPixelCount = this.getMaxCount();
        if (maxPixelCount > 0 && pixelCount > maxPixelCount) {
            pixelRatio *= Math.sqrt(maxPixelCount / pixelCount);
        }
        this.setCurrentRatio(pixelRatio);
        return pixelRatio;
    }

    public getMaxCount() {
        return this.maxCount;
    }

    public getMinRatio() {
        return this.minRatio;
    }

    public getMaxRatio() {
        return this.maxRatio;
    }

    public getCurrentRatio() {
        return this.currentRatio;
    }

    private emit<T extends EventName>(type: T, detail: PixelManagerEventMap[T]): void {
        const arr = this.listeners[type] as Array<EventListener<T>>;
        const n = arr.length;
        if (n === 0) return;
        const logError = this.component.error ?? console.error;
        if (n === 1) return run(arr[0], detail, logError);
        // Snapshot only when >1 listener, so a cb that (un)subscribes mid-emit
        // can't shift the live array and skip the next listener.
        const snapshot = arr.slice();
        for (let i = 0; i < snapshot.length; i++) run(snapshot[i], detail, logError);
    }
}
