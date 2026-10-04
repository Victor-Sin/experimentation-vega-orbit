import { createLogger } from '../utils/logger.ts';
import { hash } from '../utils/string.ts';
import { CanvasComponent } from './CanvasComponent.ts';

// Mutable per-use or non-identity options that must not affect renderer pooling
const EXCLUDED_KEYS = ['canvas', 'context', 'width', 'height', 'dpr'];

export function stableKey(tag: string, settings: Record<string, unknown> = {}): string {
    const keys = Object.keys(settings).sort();
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = settings[k];
        if (EXCLUDED_KEYS.indexOf(k) !== -1) continue;
        if (v === undefined || v === null) continue;
        const t = typeof v;
        if (t === 'object' || t === 'function') continue; // non-primitives can't key renderer identity
        obj[k] = v;
    }
    return `${tag}:${hash(JSON.stringify(obj))}`;
}

export type RendererType = 'webgl' | 'webgpu';

export interface RendererEntry {
    readonly key: string;
    readonly canvas: HTMLCanvasElement;
    readonly type: RendererType;
    renderer: unknown;
    ctx: WebGLRenderingContext | WebGL2RenderingContext | null;
    inUse: boolean;
    lastUsed: number;
    currentOwner: CanvasComponent | null;
    lastOwner: CanvasComponent | null;
    ownerCleanup?: (() => void) | null;
    dispose(): void;
}

export type RendererEntryData = {
    canvas: HTMLCanvasElement;
    renderer: unknown;
    ctx: WebGLRenderingContext | WebGL2RenderingContext | null;
    type?: RendererType;
    dispose(): void;
};

export type RendererFactory = () => RendererEntryData | Promise<RendererEntryData>;

export interface RendererPoolStats {
    /** Total renderer entries in the pool (= actual hardware contexts). */
    total: number;
    /** Entries currently borrowed by a mounted component. */
    active: number;
    /** Entries free and warm, waiting for reuse. */
    free: number;
    /** Breakdown by underlying context API. */
    byType: {
        webgl: { active: number; free: number };
        webgpu: { active: number; free: number };
    };
}

const DEFAULT_MAX_CONTEXTS = 12;

export class RendererPool {
    private static readonly entries: RendererEntry[] = [];
    private static maxContexts: number | null = DEFAULT_MAX_CONTEXTS;

    private static readonly logger = createLogger({ id: 'RendererPool', color: '#0A7A9A' });

    private static enableWarnings = true;

    public static setWarnings(enabled: boolean): void {
        this.enableWarnings = enabled;
    }

    public static size(): number {
        return this.entries.length;
    }

    public static getMaxContexts(): number | null {
        return this.maxContexts;
    }

    public static getStats(): RendererPoolStats {
        let active = 0;
        let webglActive = 0;
        let webglFree = 0;
        let webgpuActive = 0;
        let webgpuFree = 0;
        for (let i = 0; i < this.entries.length; i++) {
            const e = this.entries[i];
            if (e.inUse) active++;
            if (e.type === 'webgpu') {
                e.inUse ? webgpuActive++ : webgpuFree++; // eslint-disable-line
            } else {
                e.inUse ? webglActive++ : webglFree++; // eslint-disable-line
            }
        }
        const total = this.entries.length;
        return {
            total,
            active,
            free: total - active,
            byType: {
                webgl: { active: webglActive, free: webglFree },
                webgpu: { active: webgpuActive, free: webgpuFree }
            }
        };
    }

    public static async get(
        key: string,
        factory: RendererFactory,
        preferred?: RendererEntry | null
    ): Promise<RendererEntry> {
        // Affinity: return preferred if free, same key, still in pool
        if (preferred && !preferred.inUse && preferred.key === key) {
            for (let i = 0; i < this.entries.length; i++) {
                if (this.entries[i] === preferred) {
                    preferred.inUse = true;
                    preferred.currentOwner = null;
                    return preferred;
                }
            }
        }

        // Any free entry of same key
        for (let i = 0; i < this.entries.length; i++) {
            const e = this.entries[i];
            if (e.key === key && !e.inUse) {
                e.inUse = true;
                e.currentOwner = null;
                return e;
            }
        }

        // Soft limit: reclaim the oldest idle context to stay near `max`; never block.
        if (this.maxContexts !== null && this.entries.length >= this.maxContexts) {
            if (!this.evictLRUFree()) {
                // All contexts in use — can't reclaim. Create anyway and warn; the limit is
                // advisory (browsers may drop the oldest live context).
                if (this.enableWarnings) {
                    this.logger.warn(
                        `soft context limit (${this.maxContexts}) exceeded — ${this.entries.length + 1} live contexts, all in use. Browser may drop the oldest.`
                    );
                }
            }
        }

        const data = await factory();
        const entry: RendererEntry = {
            key,
            canvas: data.canvas,
            renderer: data.renderer,
            ctx: data.ctx,
            type: data.type ?? (data.ctx ? 'webgl' : 'webgpu'),
            inUse: true,
            lastUsed: 0,
            currentOwner: null,
            lastOwner: null,
            ownerCleanup: null,
            dispose: data.dispose
        };
        this.entries.push(entry);
        return entry;
    }

    public static release(entry: RendererEntry): void {
        entry.inUse = false;
        entry.lastUsed = performance.now();
        entry.currentOwner = null;
    }

    /**
     * Dispose a specific entry: call ownerCleanup once, dispose the GL/GPU resources, and
     * remove the entry from the pool. Returns false if the entry is not in the pool.
     */
    public static disposeEntry(entry: RendererEntry): boolean {
        for (let i = 0; i < this.entries.length; i++) {
            if (this.entries[i] === entry) {
                entry.ownerCleanup?.();
                entry.ownerCleanup = null;
                entry.dispose();
                this.entries.splice(i, 1);
                return true;
            }
        }
        return false;
    }

    public static evictLRUFree(): boolean {
        let oldest: RendererEntry | null = null;
        let oldestIdx = -1;
        for (let i = 0; i < this.entries.length; i++) {
            const e = this.entries[i];
            if (e.inUse) continue;
            if (!oldest || e.lastUsed < oldest.lastUsed) {
                oldest = e;
                oldestIdx = i;
            }
        }
        if (!oldest || oldestIdx === -1) return false;
        oldest.ownerCleanup?.();
        oldest.dispose();
        this.entries.splice(oldestIdx, 1);
        return true;
    }

    public static setMax(n: number | null): void {
        this.maxContexts = n;
        if (n === null) return;
        while (this.entries.length > n && this.evictLRUFree()) {
            /* evict down to cap */
        }
    }

    public static disposeAll(): void {
        for (let i = 0; i < this.entries.length; i++) {
            const renderer = this.entries[i];
            renderer.ownerCleanup?.();
            renderer.dispose();
        }
        this.entries.length = 0;
    }
}
