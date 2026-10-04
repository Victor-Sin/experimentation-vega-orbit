import type { Logger } from '../utils/logger.ts';
import { useScreen, type UseScreenInstance } from '../utils/screen.ts';
import { lcfirst } from '../utils/string.ts';

import type { CanvasComponent } from './CanvasComponent.ts';

import { createHook, type Hook } from '../utils/hooks.ts';
import { $CanvasManagerLogger } from '../utils/logger.ts';
import { RendererPool, type RendererPoolStats } from './RendererPool.ts';
import { createTicker, type Ticker } from './Ticker.ts';

const IS_CLIENT = typeof window !== 'undefined';

export interface Resolution {
    width: number;
    height: number;
    ratio: number;
    pixelRatio: number;
}
export interface CanvasManagerClock {
    elapsedTime: number;
    deltaTime: number;
}
export interface CanvasManagerPool<T> {
    active: T[];
    pending: T[];
}
export type ComponentPool = CanvasManagerPool<CanvasComponent>;
export type CanvasComponentConstructor = new (...args: any[]) => CanvasComponent;

export interface CanvasManagerStats {
    registered: number; // Number of registered component types
    active: number; // Total active (in-use) instances across all pools
    pending: number; // Total pending (parked, reusable) instances across all pools
    total: number; // Total component instances (active + pending)
    contexts: RendererPoolStats; // Renderer pool breakdown: total = actual hardware contexts, active = currently borrowed, free = warm/reusable
    maxContexts: number | null; // Context cap, or null when disabled
    byId: Record<string, { active: number; pending: number }>; // Per-id breakdown of active/pending instance counts
}

export interface CanvasManagerParameters {
    ticker?: Ticker;
    maxContexts?: number | null;
    enableWarnings?: boolean;
}

export interface CanvasManagerPlugin {
    readonly name: string;
    install(manager: typeof $CanvasManager): void;
    uninstall?(manager: typeof $CanvasManager): void;
}

export class $CanvasManagerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = '$CanvasManagerError';
    }
}

export class $CanvasManager {
    private static readonly registry = new Map<string, CanvasComponentConstructor>();
    private static readonly pool = new Map<string, ComponentPool>();
    private static readonly plugins = new Map<string, CanvasManagerPlugin>();

    private static ticker: Ticker | null = null;
    private static screenWatcher: UseScreenInstance | null = null;
    private static isInitialized = false;
    private static isRunning = false;
    private static enableWarnings = true;

    public static logger: Logger = $CanvasManagerLogger;
    public static log: Logger['log'] = this.logger.log.bind(this);
    public static info: Logger['info'] = this.logger.info.bind(this);
    public static warn: Logger['warn'] = this.logger.warn.bind(this);
    public static error: Logger['error'] = this.logger.error.bind(this);

    public static readonly hooks = {
        onBeforeInit: createHook<void>(),
        onAfterInit: createHook<void>(),
        onStart: createHook<void>(),
        onStop: createHook<void>(),
        onDestroy: createHook<void>(),
        onBeforeFrame: createHook<CanvasManagerClock>(),
        onAfterFrame: createHook<CanvasManagerClock>(),
        onBeforeUpdate: createHook<CanvasManagerClock>(),
        onAfterUpdate: createHook<CanvasManagerClock>(),
        onBeforeRender: createHook<CanvasManagerClock>(),
        onAfterRender: createHook<CanvasManagerClock>(),
        onComponentRegistered: createHook<{ id: string }>(),
        onComponentCreated: createHook<{ id: string; component: CanvasComponent }>(),
        onComponentPooled: createHook<{ id: string; component: CanvasComponent }>(),
        onComponentReleased: createHook<{ id: string; component: CanvasComponent }>(),
        onComponentEvicted: createHook<{
            id: string;
            component: CanvasComponent;
            reason: 'manual' | 'lru' | 'context-lost';
        }>(),
        onPluginRegistered: createHook<{ name: string }>()
    } as const;

    public static clock: CanvasManagerClock = { elapsedTime: 0, deltaTime: 0 };
    public static viewportResolution: Resolution = IS_CLIENT
        ? {
              width: window.innerWidth,
              height: window.innerHeight,
              ratio: window.innerWidth / window.innerHeight,
              pixelRatio: window.devicePixelRatio
          }
        : { width: 1, height: 1, ratio: 1, pixelRatio: 1 };

    public static get maxContexts(): number | null {
        return RendererPool.getMaxContexts();
    }

    public static get isTicking(): boolean {
        return this.isRunning;
    }

    // ----------------------------------------------
    // Public Methods
    // ----------------------------------------------

    public static registerPlugin(...pluginsToRegister: CanvasManagerPlugin[]): void {
        for (let i = 0; i < pluginsToRegister.length; i++) {
            const plugin = pluginsToRegister[i];
            if (this.plugins.has(plugin.name)) {
                this.warn(`registerPlugin: plugin "${plugin.name}" already registered, skipping.`);
                continue;
            }
            plugin.install(this);
            this.plugins.set(plugin.name, plugin);
            this.hooks.onPluginRegistered.emit({ name: plugin.name });
        }
    }

    public static unregisterPlugin(name: string): void {
        const plugin = this.plugins.get(name);
        if (!plugin) return;
        plugin.uninstall?.(this);
        this.plugins.delete(name);
    }

    public static hasPlugin(name: string): boolean {
        return this.plugins.has(name);
    }

    public static getPlugin(name: string): CanvasManagerPlugin | undefined {
        return this.plugins.get(name);
    }

    public static createCustomHook(id: string): Hook {
        const name = `on${lcfirst(id)}`;
        const hooks = this.hooks as Record<string, Hook<any>>;
        if (hooks[name]) {
            this.warn(
                `createCustomHook: hook "${name}" already exists — returning it instead of overwriting.`
            );
            return hooks[name];
        }
        const $h = createHook();
        Object.assign(this.hooks, { [name]: $h });
        return $h;
    }

    public static register(id: string, Component: CanvasComponentConstructor): void {
        const key = id.toLowerCase();
        this.registry.set(key, Component);
        this.pool.set(key, { active: [], pending: [] });
        this.hooks.onComponentRegistered.emit({ id: key });
        $CanvasManagerLogger.log('Component Registered:', key);
    }

    public static unregister(id: string): void {
        const key = id.toLowerCase();
        const pool = this.pool.get(key);

        if (pool) {
            if (pool.active.length > 0) {
                throw new $CanvasManagerError(
                    `Cannot unregister "${key}": ${pool.active.length} active instance(s). Release them first.`
                );
            }
            const pending = pool.pending.slice();
            pool.pending.length = 0;
            for (let i = 0; i < pending.length; i++) {
                pending[i].destroy();
                this.hooks.onComponentEvicted.emit({
                    id: key,
                    component: pending[i],
                    reason: 'manual'
                });
            }
        }
        this.registry.delete(key);
        this.pool.delete(key);
        $CanvasManagerLogger.log('Component Unregistered:', key);
    }

    public static has(id: string): boolean {
        return this.registry.has(id.toLowerCase());
    }

    public static async get(id: string): Promise<CanvasComponent> {
        const key = id.toLowerCase();
        const pool = this.pool.get(key);
        if (!pool)
            throw new $CanvasManagerError(
                `Component "${key}" not registered. Call $CanvasManager.register() first.`
            );

        // Sweep context-lost pending (unrecoverable once unmounted) and pick the first reusable
        let reusable: CanvasComponent | null = null;
        for (let i = pool.pending.length - 1; i >= 0; i--) {
            const c = pool.pending[i];
            if (c.isContextLost) {
                pool.pending.splice(i, 1);
                c.destroy();
                this.hooks.onComponentEvicted.emit({
                    id: key,
                    component: c,
                    reason: 'context-lost'
                });
            } else {
                reusable = c; // backward scan ends on the first (oldest) reusable entry
            }
        }
        if (reusable) {
            pool.pending.splice(pool.pending.indexOf(reusable), 1);
            pool.active.push(reusable);
            reusable.hooks.onPooled.emit();
            this.hooks.onComponentPooled.emit({ id: key, component: reusable });
            return reusable;
        }

        const ComponentClass = this.registry.get(key)!;
        const component = new ComponentClass() as CanvasComponent;
        component.processed_id = key;
        await component.onInit();
        pool.active.push(component);
        this.hooks.onComponentCreated.emit({ id: key, component });
        return component;
    }

    public static getAll(): CanvasComponent[] {
        const out: CanvasComponent[] = [];
        for (let it = this.pool.values(), r = it.next(); !r.done; r = it.next()) {
            const { active, pending } = r.value;
            for (let i = 0, n = active.length; i < n; i++) out.push(active[i]);
            for (let i = 0, n = pending.length; i < n; i++) out.push(pending[i]);
        }
        return out;
    }

    public static getAllActive(): CanvasComponent[] {
        const out: CanvasComponent[] = [];
        for (let it = this.pool.values(), r = it.next(); !r.done; r = it.next()) {
            const active = r.value.active;
            for (let i = 0, n = active.length; i < n; i++) out.push(active[i]);
        }
        return out;
    }

    public static getAllPending(): CanvasComponent[] {
        const out: CanvasComponent[] = [];
        for (let it = this.pool.values(), r = it.next(); !r.done; r = it.next()) {
            const pending = r.value.pending;
            for (let i = 0, n = pending.length; i < n; i++) out.push(pending[i]);
        }
        return out;
    }

    public static getStats(): CanvasManagerStats {
        const byId: Record<string, { active: number; pending: number }> = {};
        let active = 0;
        let pending = 0;
        for (let it = this.pool.entries(), r = it.next(); !r.done; r = it.next()) {
            const id = r.value[0];
            const a = r.value[1].active.length;
            const p = r.value[1].pending.length;
            byId[id] = { active: a, pending: p };
            active += a;
            pending += p;
        }
        return {
            registered: this.registry.size,
            active,
            pending,
            total: active + pending,
            contexts: RendererPool.getStats(),
            maxContexts: this.maxContexts,
            byId
        };
    }

    public static evict(id: string): void {
        const key = id.toLowerCase();
        const pool = this.pool.get(key);
        if (!pool) return;
        const pending = pool.pending.slice();
        pool.pending.length = 0;
        for (let i = 0; i < pending.length; i++) {
            pending[i].destroy();
            this.hooks.onComponentEvicted.emit({
                id: key,
                component: pending[i],
                reason: 'manual'
            });
        }
    }

    public static release(component: CanvasComponent): void {
        const key = component.processed_id?.toLowerCase();
        const pool = this.pool.get(key);
        if (!pool) return;
        const idx = pool.active.indexOf(component);
        if (idx === -1) return;
        pool.active.splice(idx, 1);
        if (component.isContextLost) {
            component.destroy();
            this.hooks.onComponentEvicted.emit({ id: key, component, reason: 'context-lost' });
            return;
        }
        component.scopedElapsedTime = 0;
        component.lastReleasedAt = performance.now();
        pool.pending.push(component);
        component.hooks.onReleased.emit();
        this.hooks.onComponentReleased.emit({ id: key, component });
    }

    public static setMaxContexts(n: number | null): void {
        if (this.enableWarnings && n === null) {
            this.warn(
                'setMaxContexts(null): context cap disabled. Caller accepts responsibility for context leak prevention.'
            );
        }
        RendererPool.setMax(n);
    }

    public static setTicker(ticker: Ticker | null): void {
        if (this.isRunning)
            throw new $CanvasManagerError('Cannot swap ticker while running. Call stop() first.');
        this.ticker = ticker;
    }

    public static resetTicker(): Ticker {
        const t = createTicker();
        this.ticker = t;
        return t;
    }

    // ----------------------------------------------
    // Lifecycle
    // ----------------------------------------------

    public static async init(opts?: CanvasManagerParameters): Promise<void> {
        if (opts?.enableWarnings !== undefined) {
            this.enableWarnings = opts.enableWarnings;
            RendererPool.setWarnings(this.enableWarnings);
        }

        if (opts?.maxContexts !== undefined) {
            const mc = opts.maxContexts;
            if (mc === null || (Number.isInteger(mc) && mc >= 0)) {
                this.setMaxContexts(mc);
            } else {
                this.warn(
                    `.init(): invalid maxContexts ${mc}; fallback on default ${this.maxContexts} max contexts.`
                );
            }
        }

        if (this.isInitialized) {
            if (opts?.ticker !== undefined)
                this.warn('.init(): already initialized — ticker option ignored. Use setTicker().');
            return;
        }

        this.hooks.onBeforeInit.emit();

        if (opts?.ticker !== undefined) this.ticker = opts.ticker;
        this.ticker ??= createTicker();

        if (IS_CLIENT) {
            this.screenWatcher = useScreen({
                onDebouncedUpdate: ({ width, height, dpr }: UseScreenInstance) => {
                    this.viewportResolution.width = width;
                    this.viewportResolution.height = height;
                    this.viewportResolution.ratio = width / height;
                    this.viewportResolution.pixelRatio = dpr;

                    const activeComponents = this.getAllActive();
                    for (let i = 0; i < activeComponents.length; i++) {
                        activeComponents[i].setViewportResize(this.viewportResolution);
                    }
                }
            });
        }

        this.isInitialized = true;

        this.hooks.onAfterInit.emit();

        $CanvasManagerLogger.log('Initialized');
    }

    public static start(): void {
        if (!this.isInitialized)
            throw new $CanvasManagerError(
                'Cannot start $CanvasManager without initialize it. Please call .init() before.'
            );
        if (this.isRunning) return;

        this.isRunning = true;
        this.ticker?.start(this.frame);
        this.hooks.onStart.emit();
    }

    public static stop(): void {
        if (!this.isRunning) return;
        this.isRunning = false;
        this.ticker?.stop();
        this.hooks.onStop.emit();
    }

    public static frame = (et: number, dt: number): void => {
        this.clock.elapsedTime = et;
        this.clock.deltaTime = dt;

        this.hooks.onBeforeFrame.emit(this.clock);
        this.hooks.onBeforeUpdate.emit(this.clock);

        for (let it = this.pool.values(), r = it.next(); !r.done; r = it.next()) {
            const active = r.value.active;
            for (let i = active.length - 1; i >= 0; i--) {
                const component = active[i];
                component.updateActiveState();
                if (!component.isActive) continue;
                component.scopedElapsedTime += dt;
                if (!component.isNeedsUpdate) continue;
                component.hooks.onBeforeUpdate.emit();
                component.onUpdate(this.clock);
                component.hooks.onAfterUpdate.emit();
            }
        }

        this.hooks.onAfterUpdate.emit(this.clock);
        this.hooks.onBeforeRender.emit(this.clock);

        for (let it = this.pool.values(), r = it.next(); !r.done; r = it.next()) {
            const active = r.value.active;
            for (let i = active.length - 1; i >= 0; i--) {
                const component = active[i];
                if (!component.isActive) continue;
                if (!component.isNeedsRendering) continue;
                component.hooks.onBeforeRender.emit();
                component.onRender(this.clock);
                component.hooks.onAfterRender.emit();
            }
        }

        this.hooks.onAfterRender.emit(this.clock);
        this.hooks.onAfterFrame.emit(this.clock);
    };

    public static destroy(): void {
        this.stop();

        for (let it = this.pool.entries(), r = it.next(); !r.done; r = it.next()) {
            const id = r.value[0];
            const pool = r.value[1];
            const active = pool.active.slice();
            const pending = pool.pending.slice();
            pool.active.length = 0;
            pool.pending.length = 0;
            for (let i = 0; i < active.length; i++) {
                active[i].destroy();
                this.hooks.onComponentEvicted.emit({ id, component: active[i], reason: 'manual' });
            }
            for (let i = 0; i < pending.length; i++) {
                pending[i].destroy();
                this.hooks.onComponentEvicted.emit({ id, component: pending[i], reason: 'manual' });
            }
        }
        RendererPool.disposeAll();

        this.screenWatcher?.stop();
        this.screenWatcher = null;

        this.ticker = null;
        this.clock.elapsedTime = 0;
        this.clock.deltaTime = 0;
        this.isInitialized = false;
        this.hooks.onDestroy.emit();
    }
}

// Add $CanvasManager to window context for debug purposes
if (IS_CLIENT) {
    (window as any).__WEBGPU_MANAGER__ = $CanvasManager;
}
