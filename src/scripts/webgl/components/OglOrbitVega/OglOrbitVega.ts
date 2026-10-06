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

import { Monitor } from 'gl-perf';

import { $device } from '#stores/device.ts';
import { createLogger, type Logger } from '#utils/log/logger.ts';

import type { CanvasManagerClock } from '../../core/CanvasManager.ts';
import { OglComponent } from '../../ogl/OglComponent.ts';
import colorspaceParsFragment from '../../chunks/colorspace_pars_fragment.glsl?raw';

import {
    DEFAULT_PRESET,
    DEFAULT_SHAPE,
    MIN_PLANE_COUNT,
    SHAPE_PRESETS,
    TypeShape
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

export class OglOrbitVega extends OglComponent {
    static id = 'OglOrbitVega';

    /** Toggle lil-gui inspector + gl-perf overlay. */
    static readonly DEBUG = false;

    static readonly logger: Logger = createLogger({ id: OglOrbitVega.id, color: '#222' });
    static readonly log: Logger['log'] = OglOrbitVega.logger.log;
    static readonly warn: Logger['warn'] = OglOrbitVega.logger.warn;
    static readonly info: Logger['info'] = OglOrbitVega.logger.info;

    public id = OglOrbitVega.id;

    static readonly FADE_DURATION = 0.6;
    static readonly MIN_PLANE_COUNT = MIN_PLANE_COUNT;

    private scene!: Transform;
    private camera!: Camera;
    private geometry!: Plane;
    private post!: Post;
    private fxaaPass?: Pass;

    private readonly meshes: Mesh[] = [];
    private readonly distances: { value: number }[] = [];
    private readonly offset = new Vec3();
    private readonly textureCache = new Map<string, Texture>();

    private emptyMap: Texture | null = null;
    private imageUrls: string[] = [];
    private textureReady = false;

    public planes = {
        count: MIN_PLANE_COUNT,
        gap: DEFAULT_PRESET.gap,
        size: DEFAULT_PRESET.size,
        type: DEFAULT_SHAPE,
        circle: { ...DEFAULT_PRESET.circle }
    };

    public bend = { ...DEFAULT_PRESET.bend };
    public view = { zOffset: DEFAULT_PRESET.camera.zOffset };
    public fisheye = { ...DEFAULT_PRESET.fisheye, fxaa: true };

    public scroll = {
        idleSpeed: 0.007,
        influence: 0.01,
        damping: 6,
        progress: 0.5
    };

    private direction = 1 as 1 | -1;
    private velocity = 0;
    private rate = 0;
    private idle = 0;
    private scrolled = 0;
    private lastScrollY = 0;
    private lastScopedMs = 0;

    /** Scroll / wheel velocity only counts when the host is fully in view. Idle always runs. */
    private isFullyVisible = false;
    private fullVisibilityObserver?: IntersectionObserver;

    private readonly uFxaaResolution = { value: new Vec2(1, 1) };

    private _unmountDevtools?: () => void;
    private glPerf: Monitor | null = null;

    constructor() {
        super({ renderer: { antialias: true, alpha: true } });

        this.uniforms = {
            uBendRadius: { value: this.bend.radius, type: '1f' },
            uBendByDistance: { value: this.bend.byDistance ? 1 : 0, type: '1f' },
            uDistanceFactor: { value: this.bend.distanceFactor, type: '1f' },
            uBendEnabled: { value: this.bend.enabled ? 1 : 0, type: '1f' },
            uTextureFade: { value: 0, type: '1f' },
            uFisheyeEnabled: { value: this.fisheye.enabled ? 1 : 0, type: '1f' },
            uFisheyeEffect: { value: this.fisheye.effect, type: '1f' },
            uFisheyeScale: { value: this.fisheye.scale, type: '1f' },
            ...this.uniforms
        };
    }

    public override onMounted(parent: HTMLElement): void {
        this.fullVisibilityObserver = new IntersectionObserver(
            ([entry]) => {
                this.isFullyVisible = entry?.intersectionRatio >= 1;
            },
            { threshold: 1 }
        );
        this.fullVisibilityObserver.observe(parent);

        if (OglOrbitVega.DEBUG) void this.mountDevtools();
    }

    public override onUnmounted(): void {
        this.fullVisibilityObserver?.disconnect();
        this.fullVisibilityObserver = undefined;
        this.isFullyVisible = false;

        this._unmountDevtools?.();
        this._unmountDevtools = undefined;
    }

    public onBindEvents(): void {
        this.lastScrollY = window.scrollY;
        super.onBindEvents();
    }

    public override onWheel(event: WheelEvent): void {
        if (!this.isFullyVisible || event.deltaY === 0) return;

        this.direction = event.deltaY > 0 ? 1 : -1;
        this.velocity += event.deltaY;
    }

    public override onUpdate(clock: CanvasManagerClock): void {
        super.onUpdate(clock);

        if (!this.isInitialized) return;

        const dt = clock.deltaTime * 0.001;
        const reduced = $device.get().isReducedMotion;

        // Discard scroll deltas while partially off-screen so entering doesn't spike velocity.
        const delta = window.scrollY - this.lastScrollY;
        this.lastScrollY = window.scrollY;
        const scopedDt = (this.scopedElapsedTime - this.lastScopedMs) * 0.001;
        this.lastScopedMs = this.scopedElapsedTime;

        if (!reduced) {
            if (this.isFullyVisible) {
                if (delta > 0) this.direction = 1;
                else if (delta < 0) this.direction = -1;

                // Accept new scroll input only while fully visible.
                if (delta !== 0) this.velocity = delta;
                else this.velocity *= Math.exp(-this.scroll.damping * dt);
            } else {
                // Keep damping leftover velocity after leaving the viewport.
                this.velocity *= Math.exp(-this.scroll.damping * dt);
            }

            const lerp = 1 - Math.exp(-this.scroll.damping * dt);
            this.rate += (this.velocity * this.scroll.influence - this.rate) * lerp;
            this.scrolled += this.rate * dt;

            if (scopedDt > 0) {
                this.idle += this.scroll.idleSpeed * this.direction * scopedDt;
            }
        }

        this.scroll.progress = 0.5 + this.idle + this.scrolled;
        this.syncLayout();

        if (this.textureReady && this.uniforms.uTextureFade.value < 1) {
            this.uniforms.uTextureFade.value = reduced
                ? 1
                : Math.min(1, this.uniforms.uTextureFade.value + dt / OglOrbitVega.FADE_DURATION);
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
        this.glPerf?.update();
    }

    private setupScene(): void {
        this.mountGlPerf();
        this.ctx.clearColor(0, 0, 0, 0);

        this.scene = new Transform();
        this.imageUrls = this.parseSrcImages();

        if (this.imageUrls.length === 0) {
            OglOrbitVega.warn('No images in data-src-images; planes will be untextured.');
        }

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
        this.textureReady = false;
        this.uniforms.uTextureFade.value = 0;
        this.idle = 0;
        this.scrolled = 0;
        this.lastScopedMs = 0;
        this.rate = 0;
        this.velocity = 0;
        this.scroll.progress = 0.5;

        for (let i = 0; i < count; i++) {
            const uDistance = { value: 0 };
            const url =
                this.imageUrls.length > 0 ? this.imageUrls[i % this.imageUrls.length] : undefined;

            const mesh = new Mesh(this.ctx, {
                geometry: this.geometry,
                program: new Program(this.ctx, {
                    vertex: planeVertex,
                    fragment: planeFragment,
                    transparent: true,
                    uniforms: {
                        uBendRadius: this.uniforms.uBendRadius,
                        uBendByDistance: this.uniforms.uBendByDistance,
                        uDistanceFactor: this.uniforms.uDistanceFactor,
                        uBendEnabled: this.uniforms.uBendEnabled,
                        uDistance,
                        uTextureFade: this.uniforms.uTextureFade,
                        uMap: { value: url ? this.ensureTexture(url) : this.createEmptyMap() }
                    }
                })
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
        this.disposeGlPerf();
        this.disposePost();

        this.geometry?.remove();
        for (const mesh of this.meshes) this.deleteProgram(mesh.program);
        this.disposeTextures();

        if (this.emptyMap) {
            this.ctx.deleteTexture(this.emptyMap.texture);
            this.emptyMap = null;
        }

        this.meshes.length = 0;
        this.distances.length = 0;
        this.imageUrls = [];
        this.textureReady = false;
        this.uniforms.uTextureFade.value = 0;
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

    private disposeTextures(): void {
        for (const map of Array.from(this.textureCache.values()))
            this.ctx.deleteTexture(map.texture);
        this.textureCache.clear();
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

        const image = new Image();
        image.onload = () => {
            map.image = image;
            this.textureReady = true;
        };
        image.onerror = () => OglOrbitVega.warn(`Failed to load texture: ${url}`);
        image.src = url;

        this.textureCache.set(url, map);
        return map;
    }

    private createEmptyMap(): Texture {
        if (this.emptyMap) return this.emptyMap;

        this.emptyMap = new Texture(this.ctx, {
            generateMipmaps: false
        });

        return this.emptyMap;
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
        const translateX = (this.scroll.progress * 2 - 1) * totalWidth * 3;
        const onCircle = type === TypeShape.circle;

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

            if (onCircle && circle.faceInward && this.offset.squaredLen() > 1e-8) {
                mesh.lookAt([0, 0, 0]);
            } else {
                mesh.rotation.set(0, 0, 0);
            }

            this.distances[i].value = Math.min(1, Math.abs(x) / Math.max(halfWidth, 1e-5));
        }
    }

    public applyShapePreset(type: TypeShape): void {
        const preset = SHAPE_PRESETS[type];

        this.planes.gap = preset.gap;
        this.planes.size = preset.size;
        this.planes.type = type;
        Object.assign(this.planes.circle, preset.circle);
        Object.assign(this.bend, preset.bend);
        this.view.zOffset = preset.camera.zOffset;
        Object.assign(this.fisheye, preset.fisheye);

        this.syncLayout();
        this.placeCamera();
    }

    public placeCamera(): void {
        if (!this.camera) return;

        const z = this.view.zOffset;
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

    private mountGlPerf(): void {
        if (!OglOrbitVega.DEBUG || this.glPerf) return;

        // GLPerf asks for a `webgl` context — hand it the WebGL2 context we already have.
        const gl = this.ctx;
        this.glPerf = new Monitor({ getContext: () => gl } as unknown as HTMLCanvasElement);

        if (document.getElementById('gl-perf-compact')) return;

        const style = document.createElement('style');
        style.id = 'gl-perf-compact';
        style.textContent = `
            .gl-perf { padding: 8px 12px 4px; font: 11px/1.2 arial, sans-serif; z-index: 10; }
            .gl-perf dt .unit { font-size: 9px; }
            .gl-perf dd { font-size: 16px; padding: 2px 0 8px; }
        `;
        document.body.appendChild(style);
    }

    private disposeGlPerf(): void {
        this.glPerf?.destroy();
        this.glPerf = null;
    }
}
