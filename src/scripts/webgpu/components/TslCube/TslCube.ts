import * as THREE from 'three/webgpu';
import {
    Fn,
    PI,
    atan,
    cos,
    float,
    mix,
    pass,
    positionLocal,
    select,
    sqrt,
    texture,
    uniform,
    uv,
    vec2,
    vec3,
    vec4
} from 'three/tsl';

import { $mediaStatus } from '@scripts/stores/deviceStatus';

import type { CanvasManagerClock } from '../../core/CanvasManager.ts';
import { clamp } from '../../utils/maths.ts';
import { WebgpuComponent } from '../../webgpu/WebgpuComponent.ts';
import {
    DEFAULT_PRESET,
    DEFAULT_SHAPE,
    MIN_PLANE_COUNT,
    SHAPE_PRESETS,
    TypeShape
} from './TslCube.config.ts';

// ----------------------------------------------
// Shared TSL uniforms (runtime)
// ----------------------------------------------

/** Local cylindrical bend radius (object space X). Larger = flatter. */
const bendRadius = uniform(DEFAULT_PRESET.bend.radius);
/** 1 = bend amount follows layout distance (row/circle); 0 = full bend always. */
const uBendByDistance = uniform(DEFAULT_PRESET.bend.byDistance ? 1 : 0);
const udistanceFactor = uniform(DEFAULT_PRESET.bend.distanceFactor);
/** 1 = bend on; 0 = flat planes. */
const uBendEnabled = uniform(DEFAULT_PRESET.bend.enabled ? 1 : 0);

/** 0 → 1 fade from placeholder color to loaded texture. */
const uTextureFade = uniform(0);

const TEXTURE_FADE_DURATION = 0.6;

/**
 * Post fisheye (Shadertoy wtt3z2 / cafe ll2GWV).
 * Negative = barrel (fisheye), positive = pincushion.
 */
const uFisheyeEnabled = uniform(DEFAULT_PRESET.fisheye.enabled ? 1 : 0);
const uFisheyeEffect = uniform(DEFAULT_PRESET.fisheye.effect);
const uFisheyeScale = uniform(DEFAULT_PRESET.fisheye.scale);

type FloatUniform = ReturnType<typeof uniform>;

export class TslCube extends WebgpuComponent {
    static id = 'TslCube';

    public id = TslCube.id;

    // ----------------------------------------------
    // Scene graph
    // ----------------------------------------------

    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private geometry!: THREE.PlaneGeometry;
    private group!: THREE.Group;
    private RenderPipeline!: THREE.RenderPipeline;
    private readonly meshes: THREE.Mesh[] = [];
    private readonly distanceUniforms: FloatUniform[] = [];
    private readonly layoutOffset = new THREE.Vector3();

    // ----------------------------------------------
    // Textures
    // ----------------------------------------------

    private readonly textureCache = new Map<string, THREE.Texture>();
    /** Shared stub map when `data-src-images` is empty. */
    private emptyMap: THREE.Texture | null = null;
    private planeImageUrls: string[] = [];
    private readonly textureLoader = new THREE.TextureLoader();
    /** True once at least one plane texture has finished loading. */
    private textureReady = false;

    // ----------------------------------------------
    // Runtime parameters (defaults from config; DEV inspector mutates these)
    // ----------------------------------------------

    private readonly planeParameters = {
        count: MIN_PLANE_COUNT,
        gap: DEFAULT_PRESET.gap,
        size: DEFAULT_PRESET.size,
        type: DEFAULT_SHAPE,
        circle: { ...DEFAULT_PRESET.circle }
    };

    private readonly bendParameters = {
        enabled: DEFAULT_PRESET.bend.enabled,
        radius: DEFAULT_PRESET.bend.radius,
        distanceFactor: DEFAULT_PRESET.bend.distanceFactor,
        byDistance: DEFAULT_PRESET.bend.byDistance
    };

    private readonly cameraParameters = {
        zOffset: DEFAULT_PRESET.camera.zOffset
    };

    private readonly postParameters = {
        enabled: DEFAULT_PRESET.fisheye.enabled,
        /** Negative = barrel (fisheye), positive = pincushion. */
        effect: DEFAULT_PRESET.fisheye.effect,
        scale: DEFAULT_PRESET.fisheye.scale
    };

    // ----------------------------------------------
    // Scroll / motion
    // ----------------------------------------------

    private readonly scroll = {
        idleSpeed: 0.007,
        influence: 0.01,
        damping: 6,
        /** Combined layout progress (0.5 = centered). */
        progress: 0.5,
        lastDirection: 1 as 1 | -1,
        currentRate: 0,
        velocity: 0,
        lastY: 0,
        /** Idle phase from `scopedElapsedTime` deltas. */
        idleProgress: 0,
        /** Scroll phase from damped velocity rate. */
        scrollProgress: 0,
        lastScopedElapsedMs: 0
    };

    // ----------------------------------------------
    // DEV-only (disposed on unmount; never imported in production)
    // ----------------------------------------------

    private unmountDevtools: (() => void) | null = null;

    constructor() {
        super({ id: TslCube.id, renderer: { antialias: true, alpha: false } });
    }

    // ----------------------------------------------
    // Lifecycle
    // ----------------------------------------------

    public override onRendererPooled(): void {
        super.onRendererPooled();
        this.setupScene();
    }

    public override onMounted(): void {
        if (import.meta.env.DEV) {
            void this.mountDevtools();
        }
    }

    public override onUnmounted(): void {
        this.unmountDevtools?.();
        this.unmountDevtools = null;
    }

    public override onBindEvents(): void {
        this.scroll.lastY = window.scrollY;
        super.onBindEvents();
    }

    public override onIntersect(isIntersecting: boolean): void {
        if (!isIntersecting) {
            this.scroll.velocity = 0;
            this.scroll.currentRate = 0;
        }
    }

    public override onWheel(event: WheelEvent): void {
        if (!this.isIntersecting || event.deltaY === 0) return;

        this.scroll.lastDirection = event.deltaY > 0 ? 1 : -1;
        this.scroll.velocity += event.deltaY;
    }

    public override onResize(): void {
        if (!this.camera) return;
        this.camera.aspect = this.resolution.ratio;
        this.camera.updateProjectionMatrix();
    }

    public override onUpdate({ deltaTime }: CanvasManagerClock): void {
        if (!this.isInitialized) {
            return;
        }

        const dtSeconds = deltaTime * 0.001;
        const { idleSpeed, influence, damping } = this.scroll;
        const reducedMotion = $mediaStatus.get().isReducedMotion;

        const scrollY = window.scrollY;
        const scrollDelta = scrollY - this.scroll.lastY;
        this.scroll.lastY = scrollY;

        if (scrollDelta > 0) this.scroll.lastDirection = 1;
        else if (scrollDelta < 0) this.scroll.lastDirection = -1;

        const scopedDtSeconds = (this.scopedElapsedTime - this.scroll.lastScopedElapsedMs) * 0.001;
        this.scroll.lastScopedElapsedMs = this.scopedElapsedTime;

        // Idle advances on the instance clock (pauses when inactive, resets on pool release).
        if (!reducedMotion && scopedDtSeconds > 0) {
            this.scroll.idleProgress += idleSpeed * this.scroll.lastDirection * scopedDtSeconds;
        }

        // Prefer native scroll delta; wheel impulses fill gaps (touchpad inertia / Lenis frames).
        if (scrollDelta !== 0) {
            this.scroll.velocity = scrollDelta;
        } else {
            this.scroll.velocity *= Math.exp(-damping * dtSeconds);
        }

        const velocity = !reducedMotion ? this.scroll.velocity : 0;
        const targetRate = velocity * influence;
        const lerpFactor = 1 - Math.exp(-damping * dtSeconds);
        this.scroll.currentRate += (targetRate - this.scroll.currentRate) * lerpFactor;
        this.scroll.scrollProgress += this.scroll.currentRate * dtSeconds;

        // 0.5 keeps the strip centered when idle/scroll contributions are zero.
        this.scroll.progress = 0.5 + this.scroll.idleProgress + this.scroll.scrollProgress;
        this.syncLayout();

        if (this.textureReady && uTextureFade.value < 1) {
            if (reducedMotion) {
                uTextureFade.value = 1;
            } else {
                uTextureFade.value = Math.min(
                    1,
                    uTextureFade.value + dtSeconds / TEXTURE_FADE_DURATION
                );
            }
        }
    }

    public override onRender(): void {
        this.RenderPipeline.render();
    }

    // ----------------------------------------------
    // Teardown / rebuild
    // ----------------------------------------------

    public override onContextLost(): void {
        // The device took the geometry and the compiled pipeline with it
        this.isInitialized = false;
        this.disposeScene();
    }

    public override onContextRestored(): void {
        this.setupScene();
    }

    /** The pool handed our renderer to another component, so its GPU resources are ours to free. */
    public override onRendererReleased(): void {
        this.disposeScene();
    }

    public override onDestroy(): void {
        this.disposeScene();
    }

    // ----------------------------------------------
    // Scene setup
    // ----------------------------------------------

    private setupScene(): void {
        this.scene = new THREE.Scene();
        this.planeImageUrls = this.parseSrcImages();
        if (this.planeImageUrls.length === 0) {
            this.warn('No images in data-src-images; planes will be untextured.');
        }

        const planeCount = Math.max(this.planeImageUrls.length, MIN_PLANE_COUNT);
        this.planeParameters.count = planeCount;

        this.camera = new THREE.PerspectiveCamera(45, this.resolution.ratio, 0.1, 100);

        this.geometry = new THREE.PlaneGeometry(1, 1, 16, 1);
        this.group = new THREE.Group();
        this.scene.add(this.group);

        this.meshes.length = 0;
        this.distanceUniforms.length = 0;
        this.disposeTextureCache();
        this.textureReady = false;
        uTextureFade.value = 0;
        this.scroll.idleProgress = 0;
        this.scroll.scrollProgress = 0;
        this.scroll.lastScopedElapsedMs = 0;
        this.scroll.currentRate = 0;
        this.scroll.velocity = 0;
        this.scroll.progress = 0.5;

        for (let i = 0; i < planeCount; i++) {
            const { material, uDistance } = this.createPlaneMaterial(i);
            const mesh = new THREE.Mesh(this.geometry, material);
            this.distanceUniforms.push(uDistance);
            this.meshes.push(mesh);
            this.group.add(mesh);
        }

        this.syncLayout();
        this.applyCameraOffset();
        this.setupPostProcessing();

        this.isInitialized = true;
    }

    private disposeScene(): void {
        this.RenderPipeline?.dispose();
        this.geometry?.dispose();
        for (const mesh of this.meshes) {
            (mesh.material as THREE.Material).dispose();
        }
        this.disposeTextureCache();
        this.emptyMap?.dispose();
        this.emptyMap = null;
        this.meshes.length = 0;
        this.distanceUniforms.length = 0;
        this.planeImageUrls = [];
        this.textureReady = false;
        uTextureFade.value = 0;
        this.scene?.clear();
    }

    // ----------------------------------------------
    // Data attributes
    // ----------------------------------------------

    /** Reads `data-src-images` (JSON array or comma-separated URLs). */
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
            // Fall through to comma-separated parsing
        }

        return raw
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    }

    // ----------------------------------------------
    // Textures
    // ----------------------------------------------

    /**
     * Visible plane count. Clamped to `[MIN_PLANE_COUNT, meshes.length]`.
     * When there are fewer images than the pool size, textures repeat via index modulo.
     */
    private getEffectivePlaneCount(): number {
        return clamp(this.planeParameters.count, MIN_PLANE_COUNT, this.meshes.length);
    }

    private disposeTextureCache(): void {
        for (const map of Array.from(this.textureCache.values())) {
            map.dispose();
        }
        this.textureCache.clear();
    }

    private ensureSharedTexture(url: string): THREE.Texture {
        const cached = this.textureCache.get(url);
        if (cached) return cached;

        const map = this.textureLoader.load(
            url,
            () => {
                this.textureReady = true;
            },
            undefined,
            () => {
                this.warn(`Failed to load texture: ${url}`);
            }
        );
        map.colorSpace = THREE.SRGBColorSpace;
        this.textureCache.set(url, map);
        return map;
    }

    private createPlaneMaterial(index: number): {
        material: THREE.MeshBasicNodeMaterial;
        uDistance: FloatUniform;
    } {
        const uDistance = uniform(0);
        const material = new THREE.MeshBasicNodeMaterial({
            transparent: true
        });

        const urls = this.planeImageUrls;
        const url = urls.length > 0 ? urls[index % urls.length] : undefined;
        let map: THREE.Texture;
        if (url) {
            map = this.ensureSharedTexture(url);
        } else {
            this.emptyMap ??= new THREE.Texture();
            map = this.emptyMap;
        }

        // Bend only — element position/scale live on the mesh transform
        material.positionNode = Fn(() => {
            const amount = select(uBendByDistance.equal(1), uDistance, float(1))
                .mul(udistanceFactor)
                .mul(uBendEnabled);

            const uvX = uv().x.sub(0.5);
            const theta = uvX.div(bendRadius);
            const bendZ = float(1).sub(cos(theta)).mul(bendRadius).mul(amount).negate();
            return vec3(uvX, positionLocal.y, bendZ.negate());
        })();

        material.colorNode = Fn(() => {
            const mapNode = texture(map, uv());
            const circle = uv().distance(0.5).add(0.25).step(0.75).oneMinus();
            const placeholderColor = vec4(0.588, 0.588, 0.588, circle);
            const imageColor = vec4(mapNode.rgb, mapNode.a.mul(circle));

            return mix(placeholderColor, imageColor, uTextureFade);
        })();

        return { material, uDistance };
    }

    // ----------------------------------------------
    // Layout
    // ----------------------------------------------

    private syncLayout(): void {
        const { gap, size, type, circle } = this.planeParameters;
        const count = this.getEffectivePlaneCount();
        const { progress } = this.scroll;
        const isCircle = type === TypeShape.circle;

        uBendByDistance.value = this.bendParameters.byDistance ? 1 : 0;
        uBendEnabled.value = this.bendParameters.enabled ? 1 : 0;

        const totalWidth = count * gap;
        const halfWidth = totalWidth / 2;
        const translateX = (progress * 2 - 1) * totalWidth * 3;

        for (let i = 0; i < this.meshes.length; i++) {
            const mesh = this.meshes[i];
            const visible = i < count;
            mesh.visible = visible;

            if (!visible) continue;

            const wrappedX = this.getWrappedRowX(i, gap, translateX, totalWidth);

            if (isCircle) {
                this.setCircleOffset(wrappedX, circle.radiusX, circle.radiusY);
            } else {
                this.layoutOffset.set(wrappedX, 0, 0);
            }

            mesh.position.copy(this.layoutOffset);
            mesh.scale.setScalar(size);

            if (isCircle && circle.faceInward && this.layoutOffset.lengthSq() > 1e-8) {
                mesh.lookAt(0, 0, 0);
            } else {
                mesh.rotation.set(0, 0, 0);
            }

            this.distanceUniforms[i].value = clamp(
                Math.abs(wrappedX) / Math.max(halfWidth, 1e-5),
                0,
                1
            );
        }
    }

    /** Wrap plane index onto a centered row strip of width `totalWidth`. */
    private getWrappedRowX(
        index: number,
        gap: number,
        translateX: number,
        totalWidth: number
    ): number {
        const halfWidth = totalWidth / 2;
        const rawX = -index * gap + translateX;
        const wrapped = (((rawX + halfWidth) % totalWidth) + totalWidth) % totalWidth;
        return wrapped - halfWidth;
    }

    /** Project wrapped row X onto a fixed XZ ellipse (front at -Z). Gap stays stable vs count. */
    private setCircleOffset(wrappedX: number, radiusX: number, radiusY: number): void {
        const arcRadius = Math.max((radiusX + radiusY) * 0.5, 1e-5);
        const angle = -Math.PI / 2 + wrappedX / arcRadius;
        this.layoutOffset.set(Math.cos(angle) * radiusX, 0, Math.sin(angle) * radiusY);
    }

    /** Apply base layout / bend / camera / fisheye values for the given plane type. */
    private applyShapePreset(type: TypeShape): void {
        const preset = SHAPE_PRESETS[type];

        this.planeParameters.gap = preset.gap;
        this.planeParameters.size = preset.size;
        this.planeParameters.type = type;
        this.planeParameters.circle.radiusX = preset.circle.radiusX;
        this.planeParameters.circle.radiusY = preset.circle.radiusY;
        this.planeParameters.circle.faceInward = preset.circle.faceInward;

        this.bendParameters.enabled = preset.bend.enabled;
        this.bendParameters.radius = preset.bend.radius;
        this.bendParameters.distanceFactor = preset.bend.distanceFactor;
        this.bendParameters.byDistance = preset.bend.byDistance;
        bendRadius.value = preset.bend.radius;
        udistanceFactor.value = preset.bend.distanceFactor;
        uBendEnabled.value = preset.bend.enabled ? 1 : 0;
        uBendByDistance.value = preset.bend.byDistance ? 1 : 0;

        this.cameraParameters.zOffset = preset.camera.zOffset;

        this.postParameters.enabled = preset.fisheye.enabled;
        this.postParameters.effect = preset.fisheye.effect;
        this.postParameters.scale = preset.fisheye.scale;
        uFisheyeEnabled.value = preset.fisheye.enabled ? 1 : 0;
        uFisheyeEffect.value = preset.fisheye.effect;
        uFisheyeScale.value = preset.fisheye.scale;

        this.syncLayout();
        this.applyCameraOffset();
    }

    /**
     * Place the camera on Z at `zOffset`, looking toward -Z.
     * Target is relative to the camera so the facing stays stable when zOffset changes.
     */
    private applyCameraOffset(): void {
        if (!this.camera) return;

        const z = this.cameraParameters.zOffset;
        const targetZ = z - 1;

        this.camera.up.set(0, 1, 0);
        this.camera.position.set(0, 0, z);

        this.camera.lookAt(0, 0, targetZ);
    }

    // ----------------------------------------------
    // Post-processing
    // ----------------------------------------------

    private setupPostProcessing(): void {
        this.RenderPipeline = new THREE.RenderPipeline(this.renderer);

        const scenePass = pass(this.scene, this.camera);
        const scenePassColor = scenePass.getTextureNode().toInspector('Scene Color');

        uFisheyeEnabled.value = this.postParameters.enabled ? 1 : 0;
        uFisheyeEffect.value = this.postParameters.effect;
        uFisheyeScale.value = this.postParameters.scale;

        const fisheyeUV = Fn(() => {
            const screen = uv();
            const x = screen.x.mul(2).sub(1);
            const d = x.abs();
            const z = sqrt(float(1).add(d.mul(d).mul(uFisheyeEffect)).max(1e-5));
            const r = atan(d, z).div(PI).mul(uFisheyeScale);
            const distortedX = r.mul(x.sign()).add(0.5);
            const distorted = vec2(distortedX, screen.y);

            return select(uFisheyeEnabled.equal(1), distorted, screen);
        })();

        this.RenderPipeline.outputNode = scenePassColor.sample(fisheyeUV).toInspector('Fisheye');
    }

    // ----------------------------------------------
    // DEV-only helpers (dead-code eliminated when import.meta.env.DEV is false)
    // ----------------------------------------------

    private async mountDevtools(): Promise<void> {
        const { mountTslCubeInspector } = await import('./TslCube.devtools.ts');
        this.unmountDevtools?.();
        this.unmountDevtools = mountTslCubeInspector({
            renderer: this.renderer,
            limits: { minPlaneCount: MIN_PLANE_COUNT, maxPlaneCount: this.meshes.length },
            planeParameters: this.planeParameters,
            scroll: this.scroll,
            bendParameters: this.bendParameters,
            cameraParameters: this.cameraParameters,
            postParameters: this.postParameters,
            uniforms: {
                bendRadius,
                uBendByDistance,
                udistanceFactor,
                uBendEnabled,
                uFisheyeEnabled,
                uFisheyeEffect,
                uFisheyeScale
            },
            applyShapePreset: (type) => this.applyShapePreset(type),
            syncLayout: () => this.syncLayout(),
            applyCameraOffset: () => this.applyCameraOffset()
        });
    }
}
