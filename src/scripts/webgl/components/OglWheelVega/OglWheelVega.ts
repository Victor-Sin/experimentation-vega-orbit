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

import gsap from 'gsap';

import { $device } from '#stores/device.ts';
import { createLogger, type Logger } from '#utils/log/logger.ts';

import type { CanvasManagerClock } from '../../core/CanvasManager.ts';
import { OglComponent } from '../../ogl/OglComponent.ts';
import colorspaceParsFragment from '../../chunks/colorspace_pars_fragment.glsl?raw';

import {
    BREAKPOINT_PRESETS,
    DEFAULT_BREAKPOINT,
    DEFAULT_PRESET,
    MIN_PLANE_COUNT,
    type BreakpointPresetKey
} from './OglWheelVega.config.ts';
import {
    circleOuterDiameter,
    circlePlane,
    circleRadius,
    leadingPlaneIndex,
    orthoHalfExtents,
    perspectiveHeight
} from './orbitLayout.ts';

import fxaaFragment from './fxaa.frag?raw';
import planeFragment from './plane.frag?raw';
import planeVertex from './plane.vert?raw';

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
 *   data-component-id="OglWheelVega"
 *   data-src-images='["https://…/a.jpg","https://…/b.jpg"]'>
 * </c-loco-canvas>
 * ```
 */
export class OglWheelVega extends OglComponent {
    static id = 'OglWheelVega';

    /** Toggle lil-gui inspector. */
    static readonly DEBUG = true;

    static readonly logger: Logger = createLogger({ id: OglWheelVega.id, color: '#222' });
    static readonly log: Logger['log'] = OglWheelVega.logger.log;
    static readonly warn: Logger['warn'] = OglWheelVega.logger.warn;
    static readonly info: Logger['info'] = OglWheelVega.logger.info;

    public id = OglWheelVega.id;

    static readonly FADE_DURATION = 0.6;
    /** Min planes for visual coverage / no gaps; URLs repeat (`i % length`) if fewer images. */
    static readonly MIN_PLANE_COUNT = MIN_PLANE_COUNT;
    /** Default for `scroll.travel` — how many full turns progress spans while scrolling. */
    static readonly SCROLL_TRAVEL = 1.5;

    private scene!: Transform;
    private camera!: Camera;
    private geometry!: Plane;
    private post!: Post;
    private fxaaPass?: Pass;

    private readonly meshes: Mesh[] = [];
    private readonly offset = new Vec3();
    private readonly textureCache = new Map<string, Texture>();
    private readonly programCache = new Map<string, Program>();

    private fallbackTexture: Texture | null = null;
    private fallbackProgram: Program | null = null;
    private imageUrls: string[] = [];
    private readonly textureReady = new Map<string, boolean>();
    private readonly textureFades = new Map<string, { value: number }>();

    public planes = {
        count: MIN_PLANE_COUNT,
        gap: DEFAULT_PRESET.gap,
        size: DEFAULT_PRESET.size,
        circle: { ...DEFAULT_PRESET.circle, origin: '+x' as '+x' | '-x' | '+z' | '-z' }
    };

    /** Active layout preset (`desktop` by default). */
    public breakpoint: BreakpointPresetKey = DEFAULT_BREAKPOINT;

    public fisheye = { ...DEFAULT_PRESET.fisheye, fxaa: true };

    /** Multiplier applied to `planes.size` for the mesh closest to the cardinal origin. */
    public nearestScale = 1.5;

    public scroll = {
        idleSpeed: 0.007,
        influence: 0.01,
        damping: 6,
        progress: 0.5,
        travel: OglWheelVega.SCROLL_TRAVEL
    };

    private direction = 1 as 1 | -1;
    private scrollDelta = 0;
    private scrollRate = 0;
    private idleProgress = 0;
    private scrollProgress = 0;
    private lastScrollY = 0;
    private lastScopedMs = 0;
    private ringCount = 0;
    private ringRadius = 0;
    private ringCircumference = 0;
    private ringOriginAngle = 0;
    private ringLead = 0;
    private ringSize = 0;

    private currentIndex = -1;
    private previousIndex = -1;
    private prevScrollAngle = 0;
    private hasScrollAngle = false;
    /** `undefined` until the first report, `null` when there is no image. */
    private lastImageIndex: number | null | undefined = undefined;

    private readonly uFxaaResolution = { value: new Vec2(1, 1) };

    private _unmountDevtools?: () => void;

    constructor() {
        super({ renderer: { antialias: true, alpha: true } });

        this.uniforms = {
            uFisheyeEnabled: { value: this.fisheye.enabled ? 1 : 0, type: '1f' },
            uFisheyeEffect: { value: this.fisheye.effect, type: '1f' },
            uFisheyeScale: { value: this.fisheye.scale, type: '1f' },
            ...this.uniforms
        };
    }

    public override onMounted(_parent: HTMLElement): void {
        if (OglWheelVega.DEBUG) void this.mountDevtools();
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
        this.syncWheel();

        for (const [url, fade] of this.textureFades) {
            if (!this.textureReady.get(url) || fade.value >= 1) continue;
            fade.value = reduced ? 1 : Math.min(1, fade.value + dt / OglWheelVega.FADE_DURATION);
        }
    }

    public override onResize(): void {
        if (!this.isInitialized) return;

        this.placeCamera();
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

        if (OglWheelVega.DEBUG) {
            OglWheelVega.warn('WebGL context lost, component marked as uninitialized');
        }
    }

    public override onRendererReleased(): void {
        this.disposeScene();
    }

    public override onDestroy(): void {
        this.disposeScene();

        if (OglWheelVega.DEBUG) {
            OglWheelVega.warn('Component destroyed');
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
            OglWheelVega.warn('No images in data-src-images; planes will use placeholder.');
        }

        // At least MIN_PLANE_COUNT for coverage; repeat URL pattern when fewer images.
        const count = Math.max(this.imageUrls.length, OglWheelVega.MIN_PLANE_COUNT);
        this.planes.count = count;

        this.camera = new Camera(this.ctx, { fov: 45, near: 0.1, far: 100 });
        this.camera.perspective({ aspect: this.resolution.ratio });
        this.placeCamera();

        this.geometry = new Plane(this.ctx, {
            width: 1,
            height: 1.2,
            widthSegments: 1,
            heightSegments: 1
        });

        for (const mesh of this.meshes) gsap.killTweensOf(mesh.scale);
        this.meshes.length = 0;
        this.resetNearest();
        this.disposePrograms();
        this.disposeTextures();
        this.idleProgress = 0;
        this.scrollProgress = 0;
        this.lastScopedMs = 0;
        this.scrollRate = 0;
        this.scrollDelta = 0;
        this.scroll.progress = 0.5;

        for (let i = 0; i < count; i++) {
            const url =
                this.imageUrls.length > 0 ? this.imageUrls[i % this.imageUrls.length] : undefined;

            const mesh = new Mesh(this.ctx, {
                geometry: this.geometry,
                program: url ? this.ensureProgram(url) : this.ensureFallbackProgram()
            });
            mesh.setParent(this.scene);
            this.meshes.push(mesh);
        }

        this.syncLayout();
        this.setupPost();
        this.isInitialized = true;
    }

    private disposeScene(): void {
        this.disposePost();

        this.geometry?.remove();
        this.disposePrograms();
        this.disposeTextures();

        if (this.fallbackTexture) {
            this.ctx.deleteTexture(this.fallbackTexture.texture);
            this.fallbackTexture = null;
        }

        for (const mesh of this.meshes) gsap.killTweensOf(mesh.scale);
        this.meshes.length = 0;
        this.resetNearest();
        this.imageUrls = [];
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

    private disposePrograms(): void {
        for (const program of this.programCache.values()) this.deleteProgram(program);
        this.programCache.clear();

        if (this.fallbackProgram) {
            this.deleteProgram(this.fallbackProgram);
            this.fallbackProgram = null;
        }

        this.textureFades.clear();
    }

    private ensureProgram(url: string): Program {
        const cached = this.programCache.get(url);
        if (cached) return cached;

        const uTextureFade = { value: 0 };
        this.textureFades.set(url, uTextureFade);

        const program = new Program(this.ctx, {
            vertex: planeVertex,
            fragment: planeFragment,
            transparent: true,
            uniforms: {
                uTextureFade,
                uMap: { value: this.ensureTexture(url) }
            }
        });
        this.programCache.set(url, program);
        return program;
    }

    private ensureFallbackProgram(): Program {
        if (this.fallbackProgram) return this.fallbackProgram;

        this.fallbackProgram = new Program(this.ctx, {
            vertex: planeVertex,
            fragment: planeFragment,
            transparent: true,
            uniforms: {
                uTextureFade: { value: 0 },
                uMap: { value: this.createFallbackTexture() }
            }
        });
        return this.fallbackProgram;
    }

    private disposeTextures(): void {
        for (const map of Array.from(this.textureCache.values()))
            this.ctx.deleteTexture(map.texture);
        this.textureCache.clear();
        this.textureReady.clear();
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
        image.onerror = () => OglWheelVega.warn(`Failed to load texture: ${url}`);
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

    /** Settings that do not depend on scroll: post uniforms, ring size, which mesh is first. */
    public syncLayout(): void {
        this.uniforms.uFisheyeEnabled.value = this.fisheye.enabled ? 1 : 0;
        this.uniforms.uFisheyeEffect.value = this.fisheye.effect;
        this.uniforms.uFisheyeScale.value = this.fisheye.scale;
        if (this.fxaaPass) this.fxaaPass.enabled = this.fisheye.fxaa;

        const { gap, size } = this.planes;
        const count = Math.max(
            OglWheelVega.MIN_PLANE_COUNT,
            Math.min(this.planes.count, this.meshes.length)
        );
        const origin = this.planes.circle.origin;
        let originAngle = 0;
        if (origin == '-x') originAngle = Math.PI;
        else if (origin == '+z') originAngle = Math.PI / 2;
        else if (origin == '-z') originAngle = -Math.PI / 2;

        this.ringCount = count;
        this.ringRadius = circleRadius(count, size, gap);
        this.ringCircumference = Math.max(count, 1) * (size + gap);
        this.ringOriginAngle = originAngle;
        this.ringLead = leadingPlaneIndex(count);
        this.ringSize = size;

        for (let i = 0; i < this.meshes.length; i++) {
            this.meshes[i].visible = i < count;
        }

        this.syncWheel();
    }

    /** Scroll pose: plane positions, nearest image, and its scale. */
    private syncWheel(): void {
        const count = this.ringCount;
        if (count === 0) return;

        const {
            ringRadius: radius,
            ringCircumference: circumference,
            ringOriginAngle: originAngle,
            ringLead: lead,
            ringSize: size
        } = this;
        // `scroll.travel`: progress spans several full turns while the page scrolls.
        const translateX = (this.scroll.progress * 2 - 1) * circumference * this.scroll.travel;
        const scrollAngle = radius > 1e-5 ? translateX / radius : 0;
        const angleOffset = scrollAngle + originAngle;
        const nearest =
            this.imageUrls.length > 0
                ? this.nearestMeshIndex(count, lead, scrollAngle, originAngle)
                : -1;

        for (let i = 0; i < count; i++) {
            const mesh = this.meshes[i];
            const plane = circlePlane(i, count, radius, angleOffset);
            this.offset.set(plane.x, plane.y, plane.z);
            mesh.position.copy(this.offset);
            mesh.rotation.set(plane.rotationX, plane.rotationY, 0);
        }

        if (nearest < 0) {
            this.reportNearestImage(null);
            this.syncNearestScale(-1, size);
            return;
        }

        this.reportNearestImage(nearest % this.imageUrls.length);
        this.syncNearestScale(nearest, size);
    }

    /** Mesh whose world angle is closest to the cardinal origin. */
    private nearestMeshIndex(
        count: number,
        lead: number,
        scrollAngle: number,
        originAngle: number
    ): number {
        const step = (Math.PI * 2) / count;
        const velocity = scrollAngle - (this.hasScrollAngle ? this.prevScrollAngle : scrollAngle);
        this.prevScrollAngle = scrollAngle;
        this.hasScrollAngle = true;

        let nearest = 0;
        let nearestAbs = Infinity;
        let nearestDelta = 0;

        for (let i = 0; i < count; i++) {
            const angle = scrollAngle + originAngle + (i - lead) * step;
            const delta = this.wrapAngle(angle - originAngle);
            const abs = Math.abs(delta);
            const tied = Math.abs(abs - nearestAbs) <= 1e-4;

            if (abs < nearestAbs - 1e-4) {
                nearest = i;
                nearestAbs = abs;
                nearestDelta = delta;
                continue;
            }

            if (!tied || velocity === 0) continue;

            const approaching = delta * velocity < 0;
            const currentApproaching = nearestDelta * velocity < 0;
            if (approaching && !currentApproaching) {
                nearest = i;
                nearestDelta = delta;
            }
        }

        return nearest;
    }

    private wrapAngle(angle: number): number {
        const tau = Math.PI * 2;
        return ((((angle + Math.PI) % tau) + tau) % tau) - Math.PI;
    }

    private reportNearestImage(index: number | null): void {
        if (index === this.lastImageIndex) return;

        if (index === null) OglWheelVega.log('aucune image');
        else OglWheelVega.log(index);

        this.lastImageIndex = index;
        if (index === null) return;

        this.parentElement?.dispatchEvent(
            new CustomEvent('wheel-nearest', {
                bubbles: true,
                detail: { index }
            })
        );
    }

    /** Scale only the nearest mesh. The tween runs when its index changes. */
    private syncNearestScale(nearest: number, size: number): void {
        const base = size;
        const scaled = base + base * (this.nearestScale - 1);

        if (nearest !== this.currentIndex) {
            this.previousIndex = this.currentIndex;
            this.currentIndex = nearest;

            if (this.previousIndex >= 0) this.tweenMeshScale(this.previousIndex, base);
            if (this.currentIndex >= 0) this.tweenMeshScale(this.currentIndex, scaled);
        }

        this.applyRestingScale(base, scaled);
    }

    /** Size or factor edits land immediately. A running handoff tween is left alone. */
    private applyRestingScale(base: number, scaled: number): void {
        const target = this.currentIndex >= 0 ? scaled : base;

        for (let i = 0; i < this.meshes.length; i++) {
            const mesh = this.meshes[i];
            if (!mesh.visible || gsap.isTweening(mesh.scale)) continue;

            const value = i === this.currentIndex ? target : base;
            if (Math.abs(mesh.scale.x - value) <= 1e-4) continue;
            mesh.scale.set(value);
        }
    }

    private tweenMeshScale(index: number, value: number): void {
        const mesh = this.meshes[index];
        if (!mesh) return;

        gsap.killTweensOf(mesh.scale);
        gsap.to(mesh.scale, {
            x: value,
            y: value,
            z: value,
            duration: 0.45,
            ease: 'power2.out',
            overwrite: 'auto'
        });
    }

    private resetNearest(): void {
        this.ringCount = 0;
        this.currentIndex = -1;
        this.previousIndex = -1;
        this.prevScrollAngle = 0;
        this.hasScrollAngle = false;
        this.lastImageIndex = undefined;
    }

    /** Apply a layout preset (`desktop` / `xs` / `sm` / `md`). */
    public applyBreakpointPreset(key: BreakpointPresetKey): void {
        const preset = BREAKPOINT_PRESETS[key];
        this.breakpoint = key;
        this.planes.gap = preset.gap;
        this.planes.size = preset.size;
        Object.assign(this.planes.circle, preset.circle);
        Object.assign(this.fisheye, preset.fisheye);

        if (!this.isInitialized) return;

        this.syncLayout();
        this.placeCamera();
    }

    public placeCamera(): void {
        if (!this.camera) return;

        const { gap, size, circle } = this.planes;
        const count = Math.max(OglWheelVega.MIN_PLANE_COUNT, this.planes.count);
        const radius = circleRadius(count, size, gap);
        const diameter = circleOuterDiameter(radius, size);
        const aspect = this.resolution.ratio > 0 ? this.resolution.ratio : 1;
        const height = perspectiveHeight(
            diameter,
            circle.circleVisiblePart,
            this.camera.fov,
            aspect
        );

        // Looking straight down is parallel to the default up axis.
        this.camera.up.set(0, 0, -1);
        this.camera.position.set(0, height, 0);
        this.camera.lookAt([0, 0, 0]);

        if (circle.orthographic) {
            const { halfW, halfH } = orthoHalfExtents(diameter, circle.circleVisiblePart, aspect);
            this.camera.orthographic({
                near: this.camera.near,
                far: this.camera.far,
                left: -halfW,
                right: halfW,
                bottom: -halfH,
                top: halfH
            });
        } else {
            this.camera.perspective({
                near: this.camera.near,
                far: this.camera.far,
                fov: this.camera.fov,
                aspect
            });
        }
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
        const { mountOglWheelVegaInspector } = await import('./OglWheelVega.devtools.ts');
        this._unmountDevtools?.();
        this._unmountDevtools = mountOglWheelVegaInspector(this);
    }
}
