import { $CanvasManagerLogger } from './logger.ts';

export interface Hook<T = void> {
    listen(cb: (payload: T) => void): () => void;
    subscribe(cb: (payload: T) => void): () => void;
    emit(payload: T): void;
}

// Isolate listener errors so one throwing cb can't abort an emit (and the frame).
function run<T>(cb: (p: T) => void, payload: T): void {
    try {
        cb(payload);
    } catch (err) {
        $CanvasManagerLogger.error(`Hook listener threw:`, err);
    }
}

export function createHook<T = void>(): Hook<T> {
    const cbs: Array<(p: T) => void> = [];
    let hasLast = false;
    let last: T;

    function add(cb: (p: T) => void): () => void {
        cbs.push(cb);
        return () => {
            const i = cbs.indexOf(cb);
            if (i !== -1) cbs.splice(i, 1);
        };
    }

    return {
        listen: add,
        subscribe(cb) {
            if (hasLast) cb(last);
            return add(cb);
        },
        emit(payload) {
            last = payload;
            hasLast = true;
            const n = cbs.length;
            if (n === 0) return;
            if (n === 1) return run(cbs[0], payload);
            // Snapshot only when >1 listener, so a cb that (un)subscribes
            // mid-emit can't shift the live array and skip the next listener. Single
            // listener is already captured by ref; 0 allocs on the hot per-frame path.
            const snapshot = cbs.slice();
            for (let i = 0; i < snapshot.length; i++) run(snapshot[i], payload);
        }
    };
}
