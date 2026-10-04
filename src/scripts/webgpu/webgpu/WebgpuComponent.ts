import * as THREE from 'three/webgpu';

import { CanvasComponent } from '../core/CanvasComponent.ts';
import type { Resolution } from '../core/CanvasManager.ts';
import { stableKey, type RendererEntry, type RendererEntryData } from '../core/RendererPool.ts';

// WebGPURenderer constructor defaults that define context identity (mirror of three's own defaults)
const WEBGPU_KEY_DEFAULTS = {
    alpha: true,
    depth: true,
    stencil: false,
    antialias: false,
    samples: 0,
    forceWebGL: false
} as const;

export interface WebgpuComponentParameters {
    id?: string;
    renderer?: THREE.WebGPURendererParameters;
}

export class WebgpuComponent extends CanvasComponent {
    static id = 'WebgpuComponent';

    public renderer!: THREE.WebGPURenderer;

    /** Resolved after `init()`, since that's when a failed WebGPU request is swapped for WebGL 2. */
    public isWebGPU = false;

    private _rendererOptions: THREE.WebGPURendererParameters;
    protected rendererKey: string | null = 'webgpu';

    /** Three's own handler, restored on unmount so a pooled renderer leaves no stale closure behind. */
    private _defaultDeviceLost: THREE.WebGPURenderer['onDeviceLost'] | null = null;

    private readonly _deviceLostHandler: THREE.WebGPURenderer['onDeviceLost'] = (info) => {
        this.isContextLost = true;

        if (!import.meta.env.PROD) {
            this.warn(`${info.api} device lost: ${info.message}`);
        }

        this.hooks.onContextLost.emit();
        this.onContextLost();
    };

    constructor(params: WebgpuComponentParameters = {}) {
        super(params.id);
        this._rendererOptions = params.renderer ?? {};
    }

    // ----------------------------------------------
    // Renderer pool
    // ----------------------------------------------

    public override getRendererKey(): string | null {
        if (this.rendererKey === null) return this.rendererKey;
        return stableKey(this.rendererKey, { ...WEBGPU_KEY_DEFAULTS, ...this._rendererOptions });
    }

    /**
     * Asynchronous on purpose: `render()` throws when called before the backend is ready, and the
     * manager's ticker renders on the frame following mount. `setAnimationLoop()` would await
     * `init()` for us, but the site has a single shared ticker, so the wait happens here instead.
     */
    protected override async buildRenderer(): Promise<RendererEntryData> {
        // WebGPURenderer only adopts a canvas that it receives in its options
        const canvas = document.createElement('canvas');
        const renderer = new THREE.WebGPURenderer({ canvas, ...this._rendererOptions });

        await renderer.init();

        renderer.toneMapping = THREE.NeutralToneMapping;

        const isWebGPU =
            (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;

        if (!import.meta.env.PROD) {
            this.log(`backend: ${isWebGPU ? 'WebGPU' : 'WebGL 2 (fallback)'}`);
        }

        return {
            canvas,
            renderer,
            ctx: isWebGPU ? null : (renderer.getContext() as WebGL2RenderingContext),
            type: isWebGPU ? 'webgpu' : 'webgl',
            dispose: () => void renderer.dispose()
        };
    }

    public override onRendererPooled(): void {
        const entry = this.rendererEntry as RendererEntry & { renderer: THREE.WebGPURenderer };
        this.renderer = entry.renderer;
        this.isWebGPU = entry.type === 'webgpu';
    }

    protected override mountRenderer(): void {
        // A single hook covers both backends: `device.lost` in WebGPU, `webglcontextlost` in WebGL
        this._defaultDeviceLost = this.renderer.onDeviceLost;
        this.renderer.onDeviceLost = this._deviceLostHandler;
    }

    protected override unmountRenderer(): void {
        if (this._defaultDeviceLost) {
            this.renderer.onDeviceLost = this._defaultDeviceLost;
            this._defaultDeviceLost = null;
        }
    }

    // ----------------------------------------------
    // Resize
    // ----------------------------------------------

    protected override resize(resolution: Partial<Resolution>): void {
        super.resize(resolution);

        if (!this.renderer) return;

        this.renderer.setPixelRatio(this.pixelManager.getCurrentRatio());
        // `false`: CanvasComponent.resize() already wrote the canvas CSS size
        this.renderer.setSize(this.resolution.width, this.resolution.height, false);
    }
}
