import { createLogger, type Logger } from '../utils/logger.ts';
import { useDPR, useResize, type UseDPRInstance, type UseResizeInstance } from '../utils/screen.ts';
import { createUUID } from '../utils/string.ts';
import { nextTick } from '../utils/wait.ts';

import { $CanvasManager, type CanvasManagerClock, type Resolution } from './CanvasManager.ts';

import { createHook } from '../utils/hooks.ts';
import { PixelManager } from './PixelManager.ts';
import { RendererPool, type RendererEntry, type RendererEntryData } from './RendererPool.ts';

const IS_CLIENT = typeof window !== 'undefined';

export class CanvasComponent {
    static id = 'CanvasComponent';

    public id = 'CanvasComponent';
    public processed_id = '';
    public uuid = createUUID();

    public logger: Logger;
    public log: Logger['log'];
    public info: Logger['info'];
    public warn: Logger['warn'];
    public error: Logger['error'];

    public parentElement: HTMLElement | null = null;
    public datas: Record<string, string> = {};
    public pixelManager: PixelManager = new PixelManager(this, { maxRatio: 3 });

    public resolution: Resolution = {
        width: 1,
        height: 1,
        ratio: 1,
        pixelRatio: IS_CLIENT ? window.devicePixelRatio : 1
    };

    public scopedElapsedTime = 0;

    public isInitialized = false;
    public isNeedsRendering = true;
    public isNeedsUpdate = true;
    public isMounted = false;
    public isActive = false;
    public isIntersecting = false;
    public isContextLost = false;
    public isSizeLocked = false;
    public lastReleasedAt = 0;

    public readonly hooks = {
        onMounted: createHook<HTMLElement>(),
        onUnmounted: createHook<HTMLElement>(),
        onResize: createHook<Resolution>(),
        onInit: createHook<void>(),
        onIntersect: createHook<boolean>(),
        onWheel: createHook<WheelEvent>(),
        onContextLost: createHook<void>(),
        onContextRestored: createHook<void>(),
        onBeforeUpdate: createHook<void>(),
        onAfterUpdate: createHook<void>(),
        onBeforeRender: createHook<void>(),
        onAfterRender: createHook<void>(),
        onPooled: createHook<void>(),
        onReleased: createHook<void>(),
        onDestroy: createHook<void>()
    } as const;

    protected rendererKey: string | null = null;
    protected rendererEntry: RendererEntry | null = null;
    protected lastRendererEntry: RendererEntry | null = null;

    private _canvas: HTMLCanvasElement | null = null;
    private dprWatcher: UseDPRInstance | null = null;
    private resizeWatcher: UseResizeInstance | null = null;
    private intersectionObserver: IntersectionObserver | null = null;
    private _savedMaxCount = 0;
    private _savedMaxRatio = 0;

    public get canvas(): HTMLCanvasElement {
        this._canvas ??= document.createElement('canvas');
        return this._canvas;
    }

    public set canvas(canvas: HTMLCanvasElement) {
        this._canvas = canvas;
    }

    constructor(id?: string) {
        const _id = id || this.id || CanvasComponent.id || this.constructor.name;

        this.id = _id;

        // Assign custom logger; use _id before sanitizing it to have a better looking log
        this.logger = createLogger({ id: this.id, color: '#0A7A9A' });
        this.log = this.logger.log.bind(this.logger);
        this.info = this.logger.info.bind(this.logger);
        this.warn = this.logger.warn.bind(this.logger);
        this.error = this.logger.error.bind(this.logger);
    }

    // ----------------------------------------------
    // Protected Methods
    // ----------------------------------------------

    protected setupRenderer(): void | Promise<void> {}
    protected disposeRenderer(): void {}

    protected setRendererKey(key: string | null): void {
        this.rendererKey = key;
    }

    protected getRendererKey(): string | null {
        return this.rendererKey;
    }

    /** Called by the pool factory to create a new renderer entry (canvas + renderer). Pooled adapters override. */
    protected buildRenderer(): RendererEntryData | Promise<RendererEntryData> {
        throw new Error(
            `[${this.id}] buildRenderer() not implemented — pooled adapters must override`
        );
    }

    /**
     * Called after a renderer entry is acquired in mount().
     * Adapters override to install canvas event listeners (context loss/restore).
     */
    protected mountRenderer(): void {}

    /**
     * Called before releasing the entry in unmount().
     * Adapters override to remove canvas event listeners.
     */
    protected unmountRenderer(): void {}

    protected resize({ width, height, pixelRatio }: Partial<Resolution>): void {
        this.resolution.width = width ?? this.resolution.width;
        this.resolution.height = height ?? this.resolution.height;
        this.resolution.ratio =
            this.resolution.height > 0 ? this.resolution.width / this.resolution.height : 1;

        this.pixelManager.computeDPR(
            this.resolution.width,
            this.resolution.height,
            pixelRatio || (IS_CLIENT ? window.devicePixelRatio : 1)
        );
        this.resolution.pixelRatio = this.pixelManager.getCurrentRatio();

        this.canvas.style.width = `${this.resolution.width}px`;
        this.canvas.style.height = `${this.resolution.height}px`;

        this.onResize();

        this.hooks.onResize.emit(this.resolution);
    }

    // ----------------------------------------------
    // Private Methods
    // ----------------------------------------------

    private handleResize = (size: UseResizeInstance): void => {
        if (!this.parentElement) return;
        this.resize({ width: size.width, height: size.height });
    };

    private handleDPR = (dpr: number): void => {
        this.resize({ pixelRatio: dpr });
    };

    private _onIntersect = (entries: IntersectionObserverEntry[]) => {
        const isVisible = entries[entries.length - 1]?.isIntersecting ?? true;
        this.isIntersecting = isVisible;
        this.onIntersect(isVisible);
        this.hooks.onIntersect.emit(isVisible);
    };

    private readonly _onWheel = (event: WheelEvent): void => {
        this.onWheel(event);
        this.hooks.onWheel.emit(event);
    };

    // ----------------------------------------------
    // Lifecycle
    // ----------------------------------------------

    public async onInit(): Promise<void> {
        // Pooled adapters skip setupRenderer() here — renderer is pooled on mount().
        if (this.getRendererKey() === null) {
            await this.setupRenderer();
        }
        this.isInitialized = true;
        this.hooks.onInit.emit();
    }

    private async _handlePooledRenderer() {
        const key = this.getRendererKey();
        if (key !== null) {
            // Pooled: get or pool a renderer entry
            const entry = await RendererPool.get(
                key,
                () => this.buildRenderer(),
                this.lastRendererEntry
            );

            const isWarm = entry.lastOwner === this;

            // if not the same renderer instance, dispose the previous owner's GPU resources
            if (!isWarm) {
                entry.ownerCleanup?.();
            }

            this.rendererEntry = entry;
            this.canvas = entry.canvas;
            entry.currentOwner = this;
            entry.lastOwner = this;
            entry.ownerCleanup = () => this.onRendererReleased();

            if (!isWarm) {
                this.onRendererPooled();
            }

            this.mountRenderer();
        }
    }

    public async mount(parent: HTMLElement): Promise<void> {
        await nextTick();

        this.parentElement = parent;

        await this._handlePooledRenderer();

        parent.appendChild(this.canvas);

        this.resizeWatcher = useResize(parent, { onDebouncedUpdate: this.handleResize });
        this.dprWatcher = useDPR(this.handleDPR);

        this.intersectionObserver = new IntersectionObserver(this._onIntersect, {
            rootMargin: '100px'
        });
        this.intersectionObserver.observe(parent);

        await nextTick();

        this.isMounted = true;
        this.hooks.onMounted.emit(parent);
        this.onMounted(parent);

        await nextTick();

        this.handleResize({
            width: this.resizeWatcher.width,
            height: this.resizeWatcher.height
        } as UseResizeInstance);
        this.setViewportResize($CanvasManager.viewportResolution);

        this.onBindEvents();
        this.onAfterMounted(parent);
    }

    public unmount(): void {
        if (!this.isMounted && !this.parentElement) return;

        this.resizeWatcher?.stop();
        this.dprWatcher?.stop();
        this.intersectionObserver?.disconnect();

        if (this.rendererEntry) {
            this.unmountRenderer();
            this._canvas?.parentElement?.removeChild(this._canvas);
            RendererPool.release(this.rendererEntry);
            this.lastRendererEntry = this.rendererEntry;
            this.rendererEntry = null;
        } else {
            this._canvas?.parentElement?.removeChild(this._canvas);
        }

        this.isMounted = false;

        this.onUnbindEvents();

        this.hooks.onUnmounted.emit(this.parentElement as HTMLElement);
        this.onUnmounted(this.parentElement as HTMLElement);

        this.parentElement = null;
    }

    public destroy(): void {
        this.unmount();

        // If this component was the last owner of its renderer entry, fully tear it down
        // disposeEntry calls ownerCleanup once, nulls it, disposes the GL/GPU context,
        // and removes the entry from the pool; preventing a double-call if another component
        // later cold-acquires the same slot
        const last = this.lastRendererEntry;
        if (last && last.lastOwner === this) {
            RendererPool.disposeEntry(last);
            last.lastOwner = null;
            this.lastRendererEntry = null;
        }

        // Non-pooled adapters still use the old direct disposal path.
        if (this.getRendererKey() === null) {
            this.disposeRenderer();
        }

        this.hooks.onDestroy.emit();
        this.isInitialized = false;
    }

    public lockSize(width: number, height: number, dpr = 1): void {
        if (this.isSizeLocked) return;
        this.resizeWatcher?.stop();
        this.dprWatcher?.stop();
        this._savedMaxCount = this.pixelManager.getMaxCount();
        this._savedMaxRatio = this.pixelManager.getMaxRatio();
        this.pixelManager.setMaxCount(0);
        this.pixelManager.setMaxRatio(dpr);
        this.isSizeLocked = true;
        this.resize({ width, height, pixelRatio: dpr });
    }

    public unlockSize(): void {
        if (!this.isSizeLocked) return;
        this.isSizeLocked = false;
        this.pixelManager.setMaxCount(this._savedMaxCount);
        this.pixelManager.setMaxRatio(this._savedMaxRatio);
        if (this.parentElement) {
            this.resizeWatcher = useResize(this.parentElement, {
                onDebouncedUpdate: this.handleResize
            });
            this.dprWatcher = useDPR(this.handleDPR);
            this.handleResize({
                width: this.resizeWatcher.width,
                height: this.resizeWatcher.height
            } as UseResizeInstance);
        }
    }

    public readonly updateActiveState = (): void => {
        this.isActive =
            this.isIntersecting && !this.isContextLost && this.isMounted && this.isInitialized;
    };

    // ----------------------------------------------
    // Overridable methods
    // ----------------------------------------------

    public setViewportResize(_resolution: Resolution): void {}
    public onBindEvents(): void {
        window.addEventListener('wheel', this._onWheel, { passive: true });
    }
    public onUnbindEvents(): void {
        window.removeEventListener('wheel', this._onWheel);
    }
    public onResize(_force?: boolean): void {}
    public onMounted(_parent: HTMLElement): void {}
    public onAfterMounted(_parent: HTMLElement): void {}
    public onUnmounted(_parent: HTMLElement): void {}
    public onUpdate(_: CanvasManagerClock): void {}
    public onRender(_: CanvasManagerClock): void {}
    public onDestroy(): void {}
    public onIntersect(_isIntersecting: boolean): void {}
    public onWheel(_event: WheelEvent): void {}
    public onContextLost(): void {}
    public onContextRestored(): void {}
    public onRendererPooled(): void {}
    public onRendererReleased(): void {}
}
