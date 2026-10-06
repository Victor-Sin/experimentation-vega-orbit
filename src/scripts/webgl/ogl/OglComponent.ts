import { Renderer, Vec4, type OGLRenderingContext, type RendererOptions } from 'ogl';

import { $device } from '#stores/device.ts';
import { boolean } from '#utils/convert.ts';
import { CanvasComponent } from '../core/CanvasComponent.ts';
import { $CanvasManager, type Resolution } from '../core/CanvasManager.ts';
import { stableKey, type RendererEntry, type RendererEntryData } from '../core/RendererPool.ts';
import type { Defines, Uniforms } from '../types.ts';

// OGL Renderer constructor defaults that define context identity (mirror of ogl's own defaults)
const OGL_KEY_DEFAULTS = {
    alpha: false,
    depth: true,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'default',
    webgl: 2
} as const;

export interface OglComponentParameters {
    id?: string;
    renderer?: Partial<RendererOptions>;
}

export class OglComponent extends CanvasComponent {
    static id = 'OglComponent';

    public ctx!: OGLRenderingContext;
    public renderer!: Renderer;

    public uniforms: Uniforms = {
        uScopedTime: { value: 0, type: '1f' },
        uTime: { value: 0, type: '1f' },
        uResolution: { value: new Vec4(), type: '4f' },
        uViewportResolution: { value: new Vec4(), type: '4f' }
    };

    public defines: Defines = {
        HAS_TOUCH: boolean($device.get().isTouchOrSmall, false),
        PI: Math.PI.toFixed(10),
        TAU: (Math.PI * 2).toFixed(10),
        HALF_PI: (Math.PI / 2).toFixed(10),
        EPSILON: (1e-5).toFixed(5)
    };

    private _rendererOptions: Partial<RendererOptions>;
    protected rendererKey: string | null = 'ogl';

    // Stable handlers for add/removeEventListener symmetry
    private readonly _contextLostHandler = (event: Event): void => {
        event.preventDefault();
        this.isContextLost = true;
        this.hooks.onContextLost.emit();
        this.onContextLost();
    };

    private readonly _contextRestoredHandler = (): void => {
        this.isContextLost = false;
        // Keep the pool entry's ctx reference in sync after restore
        this.ctx = this.renderer.gl;
        if (this.rendererEntry) this.rendererEntry.ctx = this.renderer.gl as WebGL2RenderingContext;
        this.hooks.onContextRestored.emit();
        this.onContextRestored();
    };

    constructor(params: OglComponentParameters = {}) {
        super(params.id);
        this._rendererOptions = params.renderer ?? {};

        const unsubTime = $CanvasManager.hooks.onBeforeUpdate.listen(({ elapsedTime }) => {
            this.uniforms.uTime.value = elapsedTime;
        });
        this.hooks.onDestroy.listen(unsubTime);
        this.hooks.onBeforeUpdate.listen(() => {
            this.uniforms.uScopedTime.value = this.scopedElapsedTime;
        });
    }

    // ----------------------------------------------
    // Renderer pool
    // ----------------------------------------------

    public override getRendererKey(): string | null {
        if (this.rendererKey === null) return this.rendererKey;
        return stableKey(this.rendererKey, { ...OGL_KEY_DEFAULTS, ...this._rendererOptions });
    }

    protected override buildRenderer(): RendererEntryData {
        const canvas = document.createElement('canvas');
        const renderer = new Renderer({ canvas, ...this._rendererOptions });
        const oglCtx = renderer.gl;
        return {
            canvas,
            renderer,
            ctx: oglCtx as WebGL2RenderingContext,
            dispose: () => {
                (oglCtx as OGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
            }
        };
    }

    public override onRendererPooled(): void {
        const entry = this.rendererEntry as RendererEntry & { renderer: Renderer };
        this.renderer = entry.renderer;
        this.ctx = this.renderer.gl;
    }

    protected override mountRenderer(): void {
        this.canvas.addEventListener('webglcontextlost', this._contextLostHandler);
        this.canvas.addEventListener('webglcontextrestored', this._contextRestoredHandler);
    }

    protected override unmountRenderer(): void {
        this.canvas.removeEventListener('webglcontextlost', this._contextLostHandler);
        this.canvas.removeEventListener('webglcontextrestored', this._contextRestoredHandler);
    }

    // ----------------------------------------------
    // Resize
    // ----------------------------------------------

    protected override resize(resolution: Partial<Resolution>): void {
        super.resize(resolution);

        const currentDpr = this.pixelManager.getCurrentRatio();
        if (this.renderer) {
            this.renderer.dpr = currentDpr;
            this.renderer.setSize(this.resolution.width, this.resolution.height);
        }

        this.uniforms.uResolution.value.set(
            this.resolution.width * currentDpr,
            this.resolution.height * currentDpr,
            this.resolution.ratio,
            currentDpr
        );
    }

    public setViewportResize(resolution: Resolution): void {
        this.uniforms.uViewportResolution.value.set(
            resolution.width,
            resolution.height,
            resolution.ratio,
            resolution.pixelRatio
        );
    }
}
