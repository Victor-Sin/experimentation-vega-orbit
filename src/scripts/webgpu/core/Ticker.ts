export interface Ticker {
    start(frame: (et: number, dt: number) => void): void | Promise<void>;
    stop(): void;
}

const IS_CLIENT = typeof window !== 'undefined';

// Caps dt after a hidden-tab refocus (rAF pauses when tab is hidden, resuming with a huge gap).
// Generous enough to leave genuinely slow frames (30fps ≈ 33ms) untouched.
const MAX_DT = 100;

export function createTicker(): Ticker {
    let rafId: number | null = null;
    let startTime = 0;
    let lastTime = 0;
    // Elapsed time carried over across stop()/start() cycles (pause/resume semantics)
    let elapsedBase = 0;
    let cb: ((et: number, dt: number) => void) | null = null;

    const loop = (now: number): void => {
        const rawDt = now - lastTime;
        const dt = Math.min(rawDt, MAX_DT);
        // Shift the time origin by the clamped excess so et stays in sync with accumulated dt
        startTime += rawDt - dt;
        lastTime = now;
        cb?.(elapsedBase + (now - startTime), dt);
        rafId = requestAnimationFrame(loop);
    };

    return {
        start(frame) {
            if (rafId !== null) return;
            if (!IS_CLIENT) {
                console.warn(
                    '[CanvasManager] requestAnimationFrame unavailable (non-browser env); ticker is a no-op.\n' +
                        'Provide a custom ticker via setTicker() before start().'
                );
                return;
            }
            cb = frame;
            startTime = performance.now();
            lastTime = startTime;
            rafId = requestAnimationFrame(loop);
        },
        stop() {
            if (rafId === null) return;
            cancelAnimationFrame(rafId);
            elapsedBase += lastTime - startTime;
            rafId = null;
            cb = null;
        }
    };
}
