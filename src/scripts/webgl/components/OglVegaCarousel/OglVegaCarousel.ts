import {
    Camera,
    Mesh,
    Plane,
    Post,
    Program,
    RenderTarget,
    Texture,
    Transform,
    Vec2,
    type Pass
} from 'ogl';

import gsap from 'gsap';

import { $device } from '../../extr/device.ts';

import type { CanvasManagerClock } from '../../core/CanvasManager.ts';
import { OglComponent } from '../../ogl/OglComponent.ts';

import fxaaFragment from './fxaa.frag?raw';

export type BreakpointPresetKey = 'xs' | 'sm' | 'md' | 'desktop';

/** Scroll tuning stored on a layout preset. `progress` stays live and is not part of this. */
export type CarouselScrollPreset = {
    idleSpeed: number;
    influence: number;
    damping: number;
    travel: number;
};

export type SharedLayoutPreset = {
    gap: number;
    size: number;
    circle: object;
    scroll: CarouselScrollPreset;
};

export type PlaneGeometrySpec = {
    width: number;
    height: number;
    widthSegments: number;
    heightSegments: number;
};

/**
 * Shared carousel base for the wheel and the orbit.
 * Image loading, scroll integration, FXAA, and the WebGL lifecycle live here.
 * Pose, plane shaders, and the camera stay on the subclass.
 */
export abstract class OglVegaCarousel extends OglComponent {
    static id = 'OglVegaCarousel';

    /** Toggle lil-gui inspector. Subclasses inherit this flag. */
    protected static readonly DEBUG = true;

    protected static readonly FADE_DURATION = 0.6;
    /** Default for `scroll.travel`. */
    protected static readonly SCROLL_TRAVEL = 2;

    protected scene!: Transform;
    /** Parent of every plane. Intro tweens land here. */
    protected meshesGroup!: Transform;
    protected camera!: Camera;
    protected geometry!: Plane;
    protected post!: Post;
    private fxaaPass?: Pass;

    protected readonly meshes: Mesh[] = [];
    protected imageUrls: string[] = [];

    private readonly textureCache = new Map<string, Texture>();
    private readonly textureReady = new Map<string, boolean>();
    private readonly textureFades = new Map<string, { value: number }>();
    private fallbackTexture: Texture | null = null;

    public abstract planes: {
        count: number;
        gap: number;
        size: number;
        circle: object;
    };

    /** Active layout preset (`desktop` by default). */
    public breakpoint: BreakpointPresetKey = 'desktop';

    public fisheye = { fxaa: true };

    public scroll = {
        idleSpeed: 0.002,
        influence: 0.01,
        damping: 18,
        progress: 0,
        travel: OglVegaCarousel.SCROLL_TRAVEL
    };

    /** False until `playIntro` finishes. Blocks scroll velocity, direction, and the nearest notification. */
    protected isReady = false;
    private introTimeline?: gsap.core.Timeline;

    protected direction = 1 as 1 | -1;
    private scrollDelta = 0;
    private scrollRate = 0;
    private idleProgress = 0;
    private scrollProgress = 0;
    private lastScrollY = 0;
    private lastScopedMs = 0;

    private readonly uFxaaResolution = { value: new Vec2(1, 1) };

    protected _unmountDevtools?: () => void;

    protected abstract get minPlaneCount(): number;

    constructor() {
        super({
            id: (new.target as typeof OglVegaCarousel).id,
            renderer: { antialias: true, alpha: true }
        });
    }

    protected get isDebug(): boolean {
        return (this.constructor as typeof OglVegaCarousel).DEBUG;
    }

    public override onMounted(_parent: HTMLElement): void {
        if (this.isDebug) void this.mountDevtools();
    }

    public override onUnmounted(): void {
        this._unmountDevtools?.();
        this._unmountDevtools = undefined;
    }

    public override onBindEvents(): void {
        this.lastScrollY = window.scrollY;
        super.onBindEvents();
    }

    public override onUpdate(clock: CanvasManagerClock): void {
        super.onUpdate(clock);

        if (!this.isInitialized) return;

        const dt = clock.deltaTime * 0.001;
        // reduced-motion: stop user acceleration only; idle keeps running.
        const reduced = $device.get().isReducedMotion;

        const delta = window.scrollY - this.lastScrollY;
        this.lastScrollY = window.scrollY;
        const scopedDt = (this.scopedElapsedTime - this.lastScopedMs) * 0.001;
        this.lastScopedMs = this.scopedElapsedTime;
        const damp = Math.exp(-this.scroll.damping * dt);

        if (!reduced) {
            if (delta > 0) {
                this.direction = 1;
                this.scrollDelta = delta;
            } else if (delta < 0) {
                this.direction = -1;
                this.scrollDelta = delta;
            } else {
                this.scrollDelta *= damp;
            }

            const lerp = 1 - damp;
            this.scrollRate += (this.scrollDelta * this.scroll.influence - this.scrollRate) * lerp;
            this.scrollProgress += this.scrollRate * dt;
        } else {
            // Decay any leftover user acceleration without accepting new input.
            this.scrollDelta *= damp;
            this.scrollRate *= damp;
        }

        if (scopedDt > 0) {
            this.idleProgress += this.scroll.idleSpeed * this.direction * scopedDt;
        }

        this.scroll.progress = this.idleProgress + this.scrollProgress;
        this.syncFromScroll();

        for (const [url, fade] of Array.from(this.textureFades.entries())) {
            if (!this.textureReady.get(url) || fade.value >= 1) continue;
            fade.value = reduced ? 1 : Math.min(1, fade.value + dt / OglVegaCarousel.FADE_DURATION);
        }
    }

    public override onResize(): void {
        if (!this.isInitialized) return;

        this.updateCameraOnResize();
        this.resizePost();
    }

    public override onRendererPooled(): void {
        super.onRendererPooled();
        this.setupScene();
    }

    public override onContextRestored(): void {
        // Context loss destroyed GPU programs/geometry. Rebuild on the restored context;
        // uniforms are shared by reference so values reconnect automatically.
        this.setupScene();
    }

    public override onContextLost(): void {
        this.isInitialized = false;
        this.disposeScene();

        if (this.isDebug) {
            this.warn('WebGL context lost, component marked as uninitialized');
        }
    }

    public override onRendererReleased(): void {
        this.disposeScene();
    }

    public override onDestroy(): void {
        this.disposeScene();

        if (this.isDebug) {
            this.warn('Component destroyed');
        }
    }

    public override onRender(): void {
        if (!this.isInitialized) return;

        this.post.render({ scene: this.scene, camera: this.camera });
    }

    /** Apply a layout preset (`desktop` / `xs` / `sm` / `md`). */
    public applyBreakpointPreset(key: BreakpointPresetKey): void {
        this.breakpoint = key;
        const preset = this.presetFor(key);
        this.applySharedLayout(preset);
        this.applyBreakpointExtras(preset);
        this.commitView();
    }

    protected setupScene(): void {
        this.ctx.clearColor(0, 0, 0, 0);

        this.scene = new Transform();
        this.meshesGroup = new Transform();
        this.meshesGroup.setParent(this.scene);
        this.imageUrls = this.parseSrcImages();

        if (this.imageUrls.length === 0) {
            this.warn('No images in data-src-images; planes will use placeholder.');
        }

        // At least minPlaneCount for coverage; repeat URL pattern when fewer images.
        const count = Math.max(this.imageUrls.length, this.minPlaneCount);
        this.planes.count = count;

        this.camera = new Camera(this.ctx, { fov: 45, near: 0.1, far: 100 });
        this.camera.perspective({ aspect: this.resolution.ratio });
        this.placeCamera();

        this.geometry = new Plane(this.ctx, this.planeGeometry());

        this.prepareRebuild();
        this.disposeMeshPrograms();
        this.meshes.length = 0;
        this.disposeTextures();
        this.textureFades.clear();
        this.resetScrollMotion();

        for (let i = 0; i < count; i++) {
            const url =
                this.imageUrls.length > 0 ? this.imageUrls[i % this.imageUrls.length] : undefined;
            const mesh = new Mesh(this.ctx, {
                geometry: this.geometry,
                program: this.createMeshProgram(i, url)
            });
            mesh.setParent(this.meshesGroup);
            this.meshes.push(mesh);
            this.onMeshCreated(i, mesh);
        }

        this.syncLayout();
        this.setupPost();
        this.isInitialized = true;
        this.playIntro();
    }

    /**
     * Starts the intro and returns its timeline.
     * `isReady` flips true on complete. The wheel adds the tweens.
     */
    protected playIntro(): gsap.core.Timeline {
        this.isReady = false;
        this.introTimeline?.kill();
        this.introTimeline = gsap.timeline({
            onComplete: () => {
                this.isReady = true;
            }
        });
        return this.introTimeline;
    }

    protected disposeScene(): void {
        this.introTimeline?.kill();
        this.introTimeline = undefined;
        this.isReady = false;
        this.disposePost();

        this.geometry?.remove();
        this.disposeMeshPrograms();
        this.disposeTextures();

        if (this.fallbackTexture) {
            this.ctx.deleteTexture(this.fallbackTexture.texture);
            this.fallbackTexture = null;
        }

        this.onMeshesDisposed();
        this.meshes.length = 0;
        this.imageUrls = [];
        this.textureFades.clear();
        this.isInitialized = false;
    }

    /** FXAA toggle. Orbit adds bend and fisheye uniforms. */
    protected syncPostUniforms(): void {
        if (this.fxaaPass) this.fxaaPass.enabled = this.fisheye.fxaa;
    }

    protected visibleCount(): number {
        return Math.max(this.minPlaneCount, Math.min(this.planes.count, this.meshes.length));
    }

    protected applySharedLayout(preset: SharedLayoutPreset): void {
        this.planes.gap = preset.gap;
        this.planes.size = preset.size;
        Object.assign(this.planes.circle, preset.circle);
        this.scroll.idleSpeed = preset.scroll.idleSpeed;
        this.scroll.influence = preset.scroll.influence;
        this.scroll.damping = preset.scroll.damping;
        this.scroll.travel = preset.scroll.travel;
    }

    /** `syncLayout` + `placeCamera`, once the scene exists. */
    protected commitView(): void {
        if (!this.isInitialized) return;

        this.syncLayout();
        this.placeCamera();
    }

    /** `uMap` and `uTextureFade` for one plane. Missing URLs use the placeholder texture. */
    protected planeTextureUniforms(url: string | undefined): {
        uTextureFade: { value: number };
        uMap: { value: Texture };
    } {
        if (!url) {
            return {
                uTextureFade: { value: 0 },
                uMap: { value: this.createFallbackTexture() }
            };
        }

        return {
            uTextureFade: this.ensureFade(url),
            uMap: { value: this.ensureTexture(url) }
        };
    }

    protected deleteProgram(program: Program): void {
        this.ctx.deleteShader(program.vertexShader);
        this.ctx.deleteShader(program.fragmentShader);
        program.remove();
    }

    protected updateCameraOnResize(): void {
        this.placeCamera();
    }

    protected addPostPasses(): void {}

    protected prepareRebuild(): void {}

    protected onMeshesDisposed(): void {}

    protected onMeshCreated(_index: number, _mesh: Mesh): void {}

    protected applyBreakpointExtras(_preset: SharedLayoutPreset): void {}

    protected abstract planeGeometry(): PlaneGeometrySpec;

    protected abstract createMeshProgram(index: number, url: string | undefined): Program;

    protected abstract disposeMeshPrograms(): void;

    protected abstract syncFromScroll(): void;

    public abstract syncLayout(): void;

    public abstract placeCamera(): void;

    protected abstract presetFor(key: BreakpointPresetKey): SharedLayoutPreset;

    protected abstract mountDevtools(): Promise<void>;

    private parseSrcImages(): string[] {
        const raw = this.datas['src-images']?.trim();
        if (!raw) return [];

        try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.filter(
                    (value): value is string => typeof value === 'string' && value.length > 0
                );
            }
        } catch {
            // Fall through to comma-separated parsing.
        }

        return raw
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    }

    private resetScrollMotion(): void {
        this.idleProgress = 0;
        this.scrollProgress = 0;
        this.lastScopedMs = 0;
        this.scrollRate = 0;
        this.scrollDelta = 0;
        this.scroll.progress = 0;
    }

    /** Rest pose for a replay. Keeps the clock sample so the next frame does not swallow elapsed idle. */
    protected resetScrollPose(): void {
        this.idleProgress = 0;
        this.scrollProgress = 0;
        this.scrollRate = 0;
        this.scrollDelta = 0;
        this.direction = 1;
        this.scroll.progress = 0;
        this.lastScrollY = window.scrollY;
        this.lastScopedMs = this.scopedElapsedTime;
    }

    private disposeTextures(): void {
        for (const map of Array.from(this.textureCache.values()))
            this.ctx.deleteTexture(map.texture);
        this.textureCache.clear();
        this.textureReady.clear();
    }

    private ensureFade(url: string): { value: number } {
        const cached = this.textureFades.get(url);
        if (cached) return cached;

        const fade = { value: 0 };
        this.textureFades.set(url, fade);
        return fade;
    }

    private ensureTexture(url: string): Texture {
        const cached = this.textureCache.get(url);
        if (cached) return cached;

        const gl = this.ctx as WebGL2RenderingContext;

        const map = new Texture(this.ctx, {
            generateMipmaps: true,
            minFilter: gl.LINEAR_MIPMAP_LINEAR,
            magFilter: gl.LINEAR,
            wrapS: gl.CLAMP_TO_EDGE,
            wrapT: gl.CLAMP_TO_EDGE,
            flipY: true,
            internalFormat: gl.SRGB8_ALPHA8
        });

        this.textureCache.set(url, map);
        this.textureReady.set(url, false);

        const image = new Image();
        image.onload = () => {
            if (this.textureCache.get(url) !== map) return;
            map.image = image;
            this.textureReady.set(url, true);
        };
        image.onerror = () => this.warn(`Failed to load texture: ${url}`);
        image.src = url;

        return map;
    }

    private createFallbackTexture(): Texture {
        if (this.fallbackTexture) return this.fallbackTexture;

        this.fallbackTexture = new Texture(this.ctx, {
            generateMipmaps: false
        });

        return this.fallbackTexture;
    }

    private resizePost(): void {
        if (!this.post) return;

        // `Post.resize` ignores `dpr` when width/height are set — pass device pixels.
        const dpr = this.resolution.pixelRatio;
        this.post.resize({
            width: Math.max(1, Math.floor(this.resolution.width * dpr)),
            height: Math.max(1, Math.floor(this.resolution.height * dpr)),
            dpr: 1
        });
        this.uFxaaResolution.value.set(this.post.resolutionWidth, this.post.resolutionHeight);
    }

    private setupPost(): void {
        this.post = new Post(this.ctx);
        this.resizePost();
        this.addPostPasses();

        this.fxaaPass = this.post.addPass({
            fragment: fxaaFragment,
            enabled: this.fisheye.fxaa,
            uniforms: { uResolution: this.uFxaaResolution }
        });
    }

    private disposePost(): void {
        if (!this.post) return;

        for (const pass of this.post.passes) this.deleteProgram(pass.program);
        this.post.geometry.remove();
        this.disposeTarget(this.post.fbo.read);
        this.disposeTarget(this.post.fbo.write);
        this.post.passes.length = 0;
        this.fxaaPass = undefined;
    }

    private disposeTarget(target: RenderTarget): void {
        const gl = this.ctx;

        gl.deleteFramebuffer(target.buffer);
        if (target.depthBuffer) gl.deleteRenderbuffer(target.depthBuffer);
        if (target.stencilBuffer) gl.deleteRenderbuffer(target.stencilBuffer);
        if (target.depthStencilBuffer) gl.deleteRenderbuffer(target.depthStencilBuffer);
        if (target.depthTexture) gl.deleteTexture(target.depthTexture.texture);
        for (const texture of target.textures) gl.deleteTexture(texture.texture);
    }
}
