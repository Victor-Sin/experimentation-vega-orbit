import { Program } from 'ogl';

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

import {
    OglVegaCarousel,
    type BreakpointPresetKey,
    type PlaneGeometrySpec,
    type SharedLayoutPreset
} from '../OglVegaCarousel/OglVegaCarousel.ts';

import { BREAKPOINT_PRESETS, DEFAULT_PRESET, MIN_PLANE_COUNT } from './OglWheelVega.config.ts';
import {
    circleOuterDiameter,
    circlePlane,
    circleRadius,
    perspectiveHeight,
    planeAngle
} from './orbitLayout.ts';

import planeFragment from './plane.frag?raw';
import planeVertex from './plane.vert?raw';

gsap.registerPlugin(ScrollTrigger);

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
export class OglWheelVega extends OglVegaCarousel {
    static id = 'OglWheelVega';

    protected override get minPlaneCount(): number {
        return MIN_PLANE_COUNT;
    }

    public planes = {
        count: MIN_PLANE_COUNT,
        gap: DEFAULT_PRESET.gap,
        size: DEFAULT_PRESET.size,
        circle: { ...DEFAULT_PRESET.circle, origin: '+x' as '+x' | '-x' | '+z' | '-z' }
    };

    /** Multiplier applied to `planes.size` for the mesh closest to the cardinal origin. */
    public nearestScale = 1.5;

    /** Intro timing, read when the intro starts. */
    public intro = { drop: 1, stagger: 0.05, delay: 0.15, lift: 10 };

    private readonly programCache = new Map<string, Program>();
    private fallbackProgram: Program | null = null;

    private ringCount = 0;
    private ringRadius = 0;
    private ringCircumference = 0;
    private ringOriginAngle = 0;
    private ringSize = 0;

    /** Added to the scroll angle. Stays put after the intro so the idle does not jump. */
    private readonly introSpin = { angle: 0 };

    private currentIndex = -1;
    private previousIndex = -1;
    private prevScrollAngle = 0;
    private hasScrollAngle = false;
    /** `undefined` until the first report, `null` when there is no image. */
    private lastImageIndex: number | null | undefined = undefined;

    /** Authored `circleVisiblePart`, kept apart from the value scroll writes. */
    private visiblePartStart = DEFAULT_PRESET.circle.circleVisiblePart;
    private visiblePartTrigger?: ScrollTrigger;
    private readonly visiblePartEase = gsap.parseEase('power2.out');

    protected override presetFor(key: BreakpointPresetKey) {
        return BREAKPOINT_PRESETS[key];
    }

    protected override planeGeometry(): PlaneGeometrySpec {
        return { width: 1, height: 1.2, widthSegments: 1, heightSegments: 1 };
    }

    protected override createMeshProgram(_index: number, url: string | undefined): Program {
        if (!url) return this.ensureFallbackProgram();

        const cached = this.programCache.get(url);
        if (cached) return cached;

        const program = new Program(this.ctx, {
            vertex: planeVertex,
            fragment: planeFragment,
            transparent: true,
            uniforms: this.planeTextureUniforms(url)
        });
        this.programCache.set(url, program);
        return program;
    }

    protected override disposeMeshPrograms(): void {
        for (const program of Array.from(this.programCache.values())) this.deleteProgram(program);
        this.programCache.clear();

        if (this.fallbackProgram) {
            this.deleteProgram(this.fallbackProgram);
            this.fallbackProgram = null;
        }
    }

    protected override prepareRebuild(): void {
        this.killScaleTweens();
        this.resetNearest();
    }

    protected override onMeshesDisposed(): void {
        this.killScaleTweens();
        this.resetNearest();
    }

    protected override disposeScene(): void {
        this.killVisiblePartTrigger();
        super.disposeScene();
    }

    protected override syncFromScroll(): void {
        this.syncWheel();
    }

    protected override applyBreakpointExtras(preset: SharedLayoutPreset): void {
        const start = (preset.circle as { circleVisiblePart?: number }).circleVisiblePart;
        if (start !== undefined) this.visiblePartStart = start;
        this.refreshVisiblePartScroll();
    }

    /** Intro tweens. `isReady` becomes true when this timeline completes. */
    protected override playIntro(): gsap.core.Timeline {
        this.ensureVisiblePartTrigger();
        const timeline = super.playIntro();

        const count = this.ringCount;
        const { drop, stagger, delay, lift } = this.intro;
        const dropDuration = drop + Math.max(count - 1, 0) * stagger;
        const total = dropDuration + delay;
        const rate = this.scroll.idleSpeed * this.direction * 4 * Math.PI * this.scroll.travel;
        const idleEnd = this.scrollAngle() + rate * total;
        // Quarter of a half-step inside the edge mesh 0 enters from, along the idle direction.
        const halfGapAngle = Math.PI / Math.max(count, 1);
        const target = -this.direction * (halfGapAngle - halfGapAngle / 4);
        this.introSpin.angle = this.wrapAngle(target - idleEnd);

        // Index order is counter-clockwise from above; the intro walks the other way from mesh 0.
        const ordered = this.meshes
            .slice(0, count)
            .map((_, i) => this.meshes[(count - i) % count].position);
        timeline.fromTo(
            ordered,
            { y: lift },
            { y: 0, duration: drop, ease: 'power2.out', stagger },
            0
        );
        timeline.to({}, { duration: delay });

        return timeline;
    }

    /** Page scroll from 0 to `visiblePartScroll` viewport heights drives the camera zoom. */
    private ensureVisiblePartTrigger(): void {
        this.killVisiblePartTrigger();
        this.visiblePartTrigger = ScrollTrigger.create({
            trigger: document.documentElement,
            start: 0,
            end: () => window.innerHeight * this.planes.circle.visiblePartScroll,
            scrub: true,
            onUpdate: (self) => this.applyVisiblePart(self.progress)
        });
        this.applyVisiblePart(this.visiblePartTrigger.progress);
    }

    /** Recalculate the end distance and write the visible part for the current scroll. */
    public refreshVisiblePartScroll(): void {
        this.visiblePartTrigger?.refresh();
        this.applyVisiblePart(this.visiblePartTrigger?.progress ?? 0);
    }

    private applyVisiblePart(progress: number): void {
        const eased = this.visiblePartEase(progress);
        this.planes.circle.circleVisiblePart = gsap.utils.interpolate(
            this.visiblePartStart,
            this.planes.circle.maxCircleVisiblePart,
            eased
        );
        if (this.meshesGroup) {
            this.meshesGroup.position.z = gsap.utils.interpolate(
                0,
                this.planes.circle.translateZ,
                eased
            );
        }
        this.placeCamera();
    }

    private killVisiblePartTrigger(): void {
        this.visiblePartTrigger?.kill();
        this.visiblePartTrigger = undefined;
    }

    /** Rest pose, then the intro. Scale waits until this timeline completes. */
    public replayIntro(): void {
        this.killScaleTweens();
        this.currentIndex = -1;
        this.previousIndex = -1;
        this.lastImageIndex = undefined;
        this.resetScrollPose();
        this.playIntro();
    }

    /** Scroll angle around Y. Progress 0.5 sits on the origin axis before the intro spin. */
    private scrollAngle(): number {
        const { ringRadius: radius, ringCircumference: circumference } = this;
        const translateX = (this.scroll.progress * 2 - 1) * circumference * this.scroll.travel;
        return translateX / radius;
    }

    /** Settings that do not depend on scroll: post uniforms and ring size. Mesh 0 stays on the origin axis. */
    public override syncLayout(): void {
        this.syncPostUniforms();

        const { gap, size } = this.planes;
        const count = this.visibleCount();
        const origin = this.planes.circle.origin;
        let originAngle = 0;
        if (origin == '-x') originAngle = Math.PI;
        else if (origin == '+z') originAngle = Math.PI / 2;
        else if (origin == '-z') originAngle = -Math.PI / 2;

        this.ringCount = count;
        this.ringRadius = circleRadius(count, size, gap);
        this.ringCircumference = Math.max(count, 1) * (size + gap);
        this.ringOriginAngle = originAngle;
        this.ringSize = size;

        for (let i = 0; i < this.meshes.length; i++) {
            this.meshes[i].visible = i < count;
        }

        this.syncWheel();
    }

    public override placeCamera(): void {
        if (!this.camera) return;

        const { gap, size, circle } = this.planes;
        const count = Math.max(this.minPlaneCount, this.planes.count);
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

        this.camera.perspective({
            near: this.camera.near,
            far: this.camera.far,
            fov: this.camera.fov,
            aspect
        });
    }

    protected override async mountDevtools(): Promise<void> {
        const { mountOglWheelVegaInspector } = await import('./OglWheelVega.devtools.ts');
        this._unmountDevtools?.();
        this._unmountDevtools = mountOglWheelVegaInspector(this);
    }

    private ensureFallbackProgram(): Program {
        if (this.fallbackProgram) return this.fallbackProgram;

        this.fallbackProgram = new Program(this.ctx, {
            vertex: planeVertex,
            fragment: planeFragment,
            transparent: true,
            uniforms: this.planeTextureUniforms(undefined)
        });
        return this.fallbackProgram;
    }

    /** Scroll pose: plane positions, nearest image, and its scale. */
    private syncWheel(): void {
        console.log('travel', this.scroll.travel);
        const count = this.ringCount;
        if (count === 0) return;

        const { ringRadius: radius, ringOriginAngle: originAngle, ringSize: size } = this;
        const scrollAngle = this.scrollAngle();
        const spun = scrollAngle + this.introSpin.angle;
        const angleOffset = spun + originAngle;
        const nearest = this.imageUrls.length > 0 ? this.nearestMeshIndex(count, spun) : -1;

        for (let i = 0; i < count; i++) {
            const mesh = this.meshes[i];
            const plane = circlePlane(i, count, radius, angleOffset);
            mesh.position.x = plane.x;
            mesh.position.z = plane.z;
            mesh.rotation.set(plane.rotationX, plane.rotationY, 0);
        }

        if (!this.isReady) {
            this.holdBaseScale(size);
            return;
        }

        if (nearest < 0) {
            this.reportNearestImage(null);
            this.syncNearestScale(-1, size);
            return;
        }

        this.reportNearestImage(nearest % this.imageUrls.length);
        this.syncNearestScale(nearest, size);
    }

    /**
     * Mesh closest to the origin axis.
     * `angle` is scroll plus the intro spin. The axis itself cancels out of the delta.
     */
    private nearestMeshIndex(count: number, scrollAngle: number): number {
        const velocity = scrollAngle - (this.hasScrollAngle ? this.prevScrollAngle : scrollAngle);
        this.prevScrollAngle = scrollAngle;
        this.hasScrollAngle = true;

        let nearest = 0;
        let nearestAbs = Infinity;
        let nearestDelta = 0;

        for (let i = 0; i < count; i++) {
            const delta = this.wrapAngle(planeAngle(i, count, scrollAngle));
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
        angle %= tau;
        if (angle > Math.PI) angle -= tau;
        if (angle < -Math.PI) angle += tau;
        return angle;
    }

    private reportNearestImage(index: number | null): void {
        if (index === this.lastImageIndex) return;

        if (index === null) this.log('aucune image');
        else this.log(index);

        this.lastImageIndex = index;
        if (index === null) return;

        this.parentElement?.dispatchEvent(
            new CustomEvent('wheel-nearest', {
                bubbles: true,
                detail: { index }
            })
        );
    }

    /** Base size during the intro. The nearest scale starts once `isReady` is true. */
    private holdBaseScale(size: number): void {
        for (const mesh of this.meshes) {
            if (!mesh.visible || gsap.isTweening(mesh.scale)) continue;
            if (Math.abs(mesh.scale.x - size) <= 1e-4) continue;
            mesh.scale.set(size, size, size);
        }
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
            this.tweenMeshScale(i, value);
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
            duration: 2,
            ease: 'power2.out',
            overwrite: 'auto'
        });
    }

    private resetNearest(): void {
        this.ringCount = 0;
        this.introSpin.angle = 0;
        this.currentIndex = -1;
        this.previousIndex = -1;
        this.prevScrollAngle = 0;
        this.hasScrollAngle = false;
        this.lastImageIndex = undefined;
    }

    private killScaleTweens(): void {
        for (const mesh of this.meshes) gsap.killTweensOf(mesh.scale);
    }
}
