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
    Vec3,
    type Pass
} from 'ogl';

import { $device } from '#stores/device.ts';
import { createLogger, type Logger } from '#utils/log/logger.ts';

import type { CanvasManagerClock } from '../../core/CanvasManager.ts';
import { OglComponent } from '../../ogl/OglComponent.ts';
import colorspaceParsFragment from '../../chunks/colorspace_pars_fragment.glsl?raw';

import {
    BREAKPOINT_PRESETS,
    DEFAULT_BREAKPOINT,
    DEFAULT_PRESET,
    DEFAULT_SHAPE,
    MIN_PLANE_COUNT,
    SHAPE_PRESETS,
    ShapeType,
    type BreakpointPresetKey
} from './OglOrbitVega.config.ts';
import { circleOffset, wrapRowX } from './orbitLayout.ts';

import fisheyeFragment from './fisheye.frag?raw';
import fxaaFragment from './fxaa.frag?raw';
import planeFragment from './plane.frag?raw';
import planeVertex from './plane.vert?raw';

// OGL `Program` does not resolve `#include`.
const fisheyeSource = fisheyeFragment.replace(
    'precision highp float;',
    `precision highp float;\n${colorspaceParsFragment}`
);

/**
 * 3D carousel section for another site.
 * Ref: https://next.frame.io/share/eab99cde-6841-47a6-8f46-cf84543e4724/568cc94a-20a9-4ed4-b93d-3a780a164f9c
 *
 * Images: `data-src-images` = JSON string[] (Shopify); `[]` → placeholder.
 * Scroll: native `scrollY` — no Locomotive Scroll in this project.
 *
 * @example
 * ```html
 * <c-loco-canvas
 *   data-component-id="OglOrbitVega"
 *   data-src-images='["https://…/a.jpg","https://…/b.jpg"]'>
 * </c-loco-canvas>
 * ```
 */
export class OglOrbitVega extends OglComponent {
    static id = 'OglOrbitVega';

    /** Toggle lil-gui inspector. */
    static readonly DEBUG = true;

    static readonly logger: Logger = createLogger({ id: OglOrbitVega.id, color: '#222' });
    static readonly log: Logger['log'] = OglOrbitVega.logger.log;
    static readonly warn: Logger['warn'] = OglOrbitVega.logger.warn;
    static readonly info: Logger['info'] = OglOrbitVega.logger.info;

    public id = OglOrbitVega.id;

    static readonly FADE_DURATION = 0.6;
    /** Min planes for visual coverage / no gaps; URLs repeat (`i % length`) if fewer images. */
    static readonly MIN_PLANE_COUNT = MIN_PLANE_COUNT;
    /** Default for `scroll.travel` — how many strip widths progress spans while scrolling. */
    static readonly SCROLL_TRAVEL = 1.5;

    private scene!: Transform;
    private camera!: Camera;
    private geometry!: Plane;
    private post!: Post;
    private fxaaPass?: Pass;

    private readonly meshes: Mesh[] = [];
    private readonly distances: { value: number }[] = [];
    private readonly offset = new Vec3();
    private readonly textureCache = new Map<string, Texture>();

    private fallbackTexture: Texture | null = null;
    private imageUrls: string[] = [];
    private readonly textureReady = new Map<string, boolean>();
    private readonly textureFades = new Map<string, { value: number }>();

    public planes = {
        count: MIN_PLANE_COUNT,
        gap: DEFAULT_PRESET.gap,
        size: DEFAULT_PRESET.size,
        type: DEFAULT_SHAPE,
        circle: { ...DEFAULT_PRESET.circle }
    };

    /** Active layout preset (`desktop` by default). */
    public breakpoint: BreakpointPresetKey = DEFAULT_BREAKPOINT;

    public bend = { ...DEFAULT_PRESET.bend };
    public cameraOffset = { zOffset: DEFAULT_PRESET.cameraOffset.zOffset };
    public fisheye = { ...DEFAULT_PRESET.fisheye, fxaa: true };

    public scroll = {
        idleSpeed: 0.007,
        influence: 0.01,
        damping: 6,
        progress: 0.5,
        travel: OglOrbitVega.SCROLL_TRAVEL
    };

    private direction = 1 as 1 | -1;
    private scrollDelta = 0;
    private scrollRate = 0;
    private idleProgress = 0;
    private scrollProgress = 0;
    private lastScrollY = 0;
    private lastScopedMs = 0;

    private readonly uFxaaResolution = { value: new Vec2(1, 1) };

    private _unmountDevtools?: () => void;

    constructor() {
        super({ renderer: { antialias: true, alpha: true } });

        this.uniforms = {
            uBendRadius: { value: this.bend.radius, type: '1f' },
            uBendByDistance: { value: this.bend.byDistance ? 1 : 0, type: '1f' },
            uDistanceFactor: { value: this.bend.distanceFactor, type: '1f' },
            uBendEnabled: { value: this.bend.enabled ? 1 : 0, type: '1f' },
            uFisheyeEnabled: { value: this.fisheye.enabled ? 1 : 0, type: '1f' },
            uFisheyeEffect: { value: this.fisheye.effect, type: '1f' },
            uFisheyeScale: { value: this.fisheye.scale, type: '1f' },
            ...this.uniforms
        };
    }

    public override onMounted(_parent: HTMLElement): void {
        if (OglOrbitVega.DEBUG) void this.mountDevtools();
    }

    public override onUnmounted(): void {
        this._unmountDevtools?.();
        this._unmountDevtools = undefined;
    }

    public onBindEvents(): void {
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

        this.scroll.progress = 0.5 + this.idleProgress + this.scrollProgress;
        this.syncLayout();

        for (const [url, fade] of Array.from(this.textureFades.entries())) {
            if (!this.textureReady.get(url) || fade.value >= 1) continue;
            fade.value = reduced ? 1 : Math.min(1, fade.value + dt / OglOrbitVega.FADE_DURATION);
        }
    }

    public override onResize(): void {
        if (!this.isInitialized) return;

        this.camera.perspective({ aspect: this.resolution.ratio });
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

        if (OglOrbitVega.DEBUG) {
            OglOrbitVega.warn('WebGL context lost, component marked as uninitialized');
        }
    }

    public override onRendererReleased(): void {
        this.disposeScene();
    }

    public override onDestroy(): void {
        this.disposeScene();

        if (OglOrbitVega.DEBUG) {
            OglOrbitVega.warn('Component destroyed');
        }
    }

    public override onRender(): void {
        if (!this.isInitialized) return;

        this.post.render({ scene: this.scene, camera: this.camera });
    }

    private setupScene(): void {
        this.ctx.clearColor(0, 0, 0, 0);

        this.scene = new Transform();
        this.imageUrls = this.parseSrcImages();

        if (this.imageUrls.length === 0) {
            OglOrbitVega.warn('No images in data-src-images; planes will use placeholder.');
        }

        // At least MIN_PLANE_COUNT for coverage; repeat URL pattern when fewer images.
        const count = Math.max(this.imageUrls.length, OglOrbitVega.MIN_PLANE_COUNT);
        this.planes.count = count;

        this.camera = new Camera(this.ctx, { fov: 45, near: 0.1, far: 100 });
        this.camera.perspective({ aspect: this.resolution.ratio });
        this.placeCamera();

        this.geometry = new Plane(this.ctx, {
            width: 1,
            height: 1,
            widthSegments: 8,
            heightSegments: 1
        });

        this.meshes.length = 0;
        this.distances.length = 0;
        this.disposeTextures();
        this.textureFades.clear();
        this.idleProgress = 0;
        this.scrollProgress = 0;
        this.lastScopedMs = 0;
        this.scrollRate = 0;
        this.scrollDelta = 0;
        this.scroll.progress = 0.5;

        for (let i = 0; i < count; i++) {
            const uDistance = { value: 0 };
            const url =
                this.imageUrls.length > 0 ? this.imageUrls[i % this.imageUrls.length] : undefined;

            const mesh = new Mesh(this.ctx, {
                geometry: this.geometry,
                program: this.createProgram(url, uDistance)
            });
            mesh.setParent(this.scene);
            this.meshes.push(mesh);
            this.distances.push(uDistance);
        }

        this.syncLayout();
        this.setupPost();
        this.isInitialized = true;
    }

    private disposeScene(): void {
        this.disposePost();

        this.geometry?.remove();
        for (const mesh of this.meshes) this.deleteProgram(mesh.program);
        this.disposeTextures();

        if (this.fallbackTexture) {
            this.ctx.deleteTexture(this.fallbackTexture.texture);
            this.fallbackTexture = null;
        }

        this.meshes.length = 0;
        this.distances.length = 0;
        this.imageUrls = [];
        this.textureFades.clear();
        this.isInitialized = false;
    }

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

    private createProgram(url: string | undefined, uDistance: { value: number }): Program {
        return new Program(this.ctx, {
            vertex: planeVertex,
            fragment: planeFragment,
            transparent: true,
            uniforms: {
                uBendRadius: this.uniforms.uBendRadius,
                uBendByDistance: this.uniforms.uBendByDistance,
                uDistanceFactor: this.uniforms.uDistanceFactor,
                uBendEnabled: this.uniforms.uBendEnabled,
                uDistance,
                uTextureFade: url ? this.ensureFade(url) : { value: 0 },
                uMap: { value: url ? this.ensureTexture(url) : this.createFallbackTexture() }
            }
        });
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
            map.image = image;
            this.textureReady.set(url, true);
        };
        image.onerror = () => OglOrbitVega.warn(`Failed to load texture: ${url}`);
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

    public syncLayout(): void {
        this.uniforms.uBendRadius.value = this.bend.radius;
        this.uniforms.uBendByDistance.value = this.bend.byDistance ? 1 : 0;
        this.uniforms.uDistanceFactor.value = this.bend.distanceFactor;
        this.uniforms.uBendEnabled.value = this.bend.enabled ? 1 : 0;
        this.uniforms.uFisheyeEnabled.value = this.fisheye.enabled ? 1 : 0;
        this.uniforms.uFisheyeEffect.value = this.fisheye.effect;
        this.uniforms.uFisheyeScale.value = this.fisheye.scale;
        if (this.fxaaPass) this.fxaaPass.enabled = this.fisheye.fxaa;

        const { gap, size, type, circle } = this.planes;
        const count = Math.max(
            OglOrbitVega.MIN_PLANE_COUNT,
            Math.min(this.planes.count, this.meshes.length)
        );
        const totalWidth = count * gap;
        const halfWidth = totalWidth / 2;
        // `scroll.travel`: progress spans several strip widths so the carousel loops more during page scroll.
        const translateX = (this.scroll.progress * 2 - 1) * totalWidth * this.scroll.travel;
        const onCircle = type === ShapeType.circle;

        for (let i = 0; i < this.meshes.length; i++) {
            const mesh = this.meshes[i];
            mesh.visible = i < count;
            if (!mesh.visible) continue;

            const x = wrapRowX(i, gap, translateX, totalWidth);

            if (onCircle) {
                const { x: cx, y, z } = circleOffset(x, circle.radiusX, circle.radiusY);
                this.offset.set(cx, y, z);
            } else {
                this.offset.set(x, 0, 0);
            }

            mesh.position.copy(this.offset);
            mesh.scale.set(size);

            if (onCircle && circle.faceInward) {
                mesh.lookAt([0, 0, 0]);
            } else {
                mesh.rotation.set(0, 0, 0);
            }

            this.distances[i].value = Math.min(1, Math.abs(x) / halfWidth);
        }
    }

    public applyShapePreset(type: ShapeType): void {
        const preset = SHAPE_PRESETS[type];

        this.planes.gap = preset.gap;
        this.planes.size = preset.size;
        this.planes.type = type;
        Object.assign(this.planes.circle, preset.circle);
        Object.assign(this.bend, preset.bend);
        this.cameraOffset.zOffset = preset.cameraOffset.zOffset;
        Object.assign(this.fisheye, preset.fisheye);

        this.syncLayout();
        this.placeCamera();
    }

    /** Apply a layout preset (`desktop` / `xs` / `sm` / `md`). */
    public applyBreakpointPreset(key: BreakpointPresetKey): void {
        const preset = BREAKPOINT_PRESETS[key];
        this.breakpoint = key;
        this.planes.gap = preset.gap;
        this.planes.size = preset.size;
        Object.assign(this.planes.circle, preset.circle);
        Object.assign(this.bend, preset.bend);
        this.cameraOffset.zOffset = preset.cameraOffset.zOffset;
        Object.assign(this.fisheye, preset.fisheye);

        if (!this.isInitialized) return;

        this.syncLayout();
        this.placeCamera();
    }

    public placeCamera(): void {
        if (!this.camera) return;

        const z = this.cameraOffset.zOffset;
        this.camera.position.set(0, 0, z);
        this.camera.lookAt([0, 0, z - 1]);
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

        this.post.addPass({
            fragment: fisheyeSource,
            uniforms: {
                uFisheyeEnabled: this.uniforms.uFisheyeEnabled,
                uFisheyeEffect: this.uniforms.uFisheyeEffect,
                uFisheyeScale: this.uniforms.uFisheyeScale
            }
        });

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

    private deleteProgram(program: Program): void {
        this.ctx.deleteShader(program.vertexShader);
        this.ctx.deleteShader(program.fragmentShader);
        program.remove();
    }

    private async mountDevtools(): Promise<void> {
        const { mountOglOrbitVegaInspector } = await import('./OglOrbitVega.devtools.ts');
        this._unmountDevtools?.();
        this._unmountDevtools = mountOglOrbitVegaInspector(this);
    }
}
