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
    /** True until scroll passes the host top by `atTopLeavePx`; true again only at that top. */
    private pageAtTop = true;
    private readonly atTopLeavePx = 8;
    /** Scroll position where the host top meets the viewport top. Absent until mount. */
    private elementTopTrigger?: ScrollTrigger;
    /** `undefined` until the first report, `null` when the label should be Plants. */
    private lastImageIndex: number | null | undefined = undefined;

    private visiblePartTimeline?: gsap.core.Timeline;

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

    public override onMounted(parent: HTMLElement): void {
        super.onMounted(parent);
        this.ensureElementTopTrigger();
    }

    public override onUnmounted(): void {
        this.killElementTopTrigger();
        super.onUnmounted();
    }

    protected override setupScene(): void {
        this.ensureElementTopTrigger();
        super.setupScene();
    }

    protected override disposeScene(): void {
        this.killVisiblePartTrigger();
        this.killElementTopTrigger();
        super.disposeScene();
    }

    protected override syncFromScroll(): void {
        this.syncWheel();
    }

    protected override applyBreakpointExtras(_preset: SharedLayoutPreset): void {
        this.refreshVisiblePartScroll();
    }

    protected override updateCameraOnResize(): void {
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

    /**
     * From the host top at the viewport top, across `visiblePartScroll` of the host height.
     * Camera Y and ring Z are the two tweened properties; `scrub` ties them to the scrollbar.
     * The `end` function runs on ScrollTrigger refresh, not on the frame path.
     */
    private ensureVisiblePartTrigger(): void {
        this.killVisiblePartTrigger();
        if (!this.camera || !this.meshesGroup || !this.parentElement) return;

        const trigger = this.parentElement;
        this.visiblePartTimeline = gsap.timeline({
            scrollTrigger: {
                trigger,
                start: 'top top',
                end: () => `+=${trigger.offsetHeight * this.planes.circle.visiblePartScroll}`,
                scrub: 0.4,
                invalidateOnRefresh: true
            }
        });

        this.visiblePartTimeline.fromTo(
            this.camera.position,
            { y: () => this.cameraHeightFor(this.planes.circle.circleVisiblePart) },
            {
                y: () => this.cameraHeightFor(this.planes.circle.maxCircleVisiblePart),
                ease: 'power2.out',
                duration: 1
            },
            0
        );
        this.visiblePartTimeline.fromTo(
            this.meshesGroup.position,
            { z: 0 },
            {
                z: () => this.planes.circle.translateZ,
                ease: 'power2.out',
                duration: 1
            },
            0
        );
    }

    /** Recalculate the scroll distance and the two Y/Z endpoints. */
    public refreshVisiblePartScroll(): void {
        this.placeCamera();
        this.visiblePartTimeline?.invalidate();
        this.visiblePartTimeline?.scrollTrigger?.refresh();
        this.elementTopTrigger?.refresh();
    }

    private killVisiblePartTrigger(): void {
        this.visiblePartTimeline?.scrollTrigger?.kill();
        this.visiblePartTimeline?.kill();
        this.visiblePartTimeline = undefined;
    }

    /** One layout read at create and on ScrollTrigger refresh. The frame path only reads `.start`. */
    private ensureElementTopTrigger(): void {
        if (this.elementTopTrigger || !this.parentElement) return;

        this.elementTopTrigger = ScrollTrigger.create({
            trigger: this.parentElement,
            start: 'top top',
            end: 'bottom top'
        });
    }

    private killElementTopTrigger(): void {
        this.elementTopTrigger?.kill();
        this.elementTopTrigger = undefined;
    }

    /** Rest pose, then the intro. Scale waits until this timeline completes. */
    public replayIntro(): void {
        this.killScaleTweens();
        this.currentIndex = -1;
        this.previousIndex = -1;
        this.lastImageIndex = undefined;
        this.resetScrollPose();
        this.reportNearestImage(null, true);
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

        const aspect = this.resolution.ratio > 0 ? this.resolution.ratio : 1;

        // Looking straight down is parallel to the default up axis.
        this.camera.up.set(0, 0, -1);
        this.camera.position.x = 0;
        this.camera.position.z = 0;
        if (!this.visiblePartTimeline) {
            this.camera.position.y = this.cameraHeightFor(this.planes.circle.circleVisiblePart);
        }
        this.camera.lookAt([0, 0, 0]);

        this.camera.perspective({
            near: this.camera.near,
            far: this.camera.far,
            fov: this.camera.fov,
            aspect
        });
    }

    /** Camera height so `visiblePart` of the canvas width is filled by the ring diameter. */
    private cameraHeightFor(visiblePart: number): number {
        if (!this.camera) return 0;

        const { gap, size } = this.planes;
        const count = Math.max(this.minPlaneCount, this.planes.count);
        const radius = circleRadius(count, size, gap);
        const diameter = circleOuterDiameter(radius, size);
        const aspect = this.resolution.ratio > 0 ? this.resolution.ratio : 1;
        return perspectiveHeight(diameter, visiblePart, this.camera.fov, aspect);
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

        const atTop = this.syncPageAtTop();

        if (nearest < 0 || !atTop) {
            this.reportNearestImage(null);
            if (!atTop) this.releaseNearestScale(size);
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

    /** Distance past the host top. Leave after a few pixels; come back only at 0, so a 1–2px bounce does not flip the scale. */
    private syncPageAtTop(): boolean {
        const start = this.elementTopTrigger?.start ?? 0;
        const y = window.scrollY - start;
        if (y <= 0) this.pageAtTop = true;
        else if (y > this.atTopLeavePx) this.pageAtTop = false;
        return this.pageAtTop;
    }

    private wrapAngle(angle: number): number {
        const tau = Math.PI * 2;
        angle %= tau;
        if (angle > Math.PI) angle -= tau;
        if (angle < -Math.PI) angle += tau;
        return angle;
    }

    private reportNearestImage(index: number | null, immediate = false): void {
        if (index === this.lastImageIndex && !immediate) return;

        if (index === null) {
            if (!immediate && this.pageAtTop) this.log('aucune image');
        } else this.log(index);

        this.lastImageIndex = index;
        this.parentElement?.dispatchEvent(
            new CustomEvent('wheel-nearest', {
                bubbles: true,
                detail: immediate ? { index, immediate: true } : { index }
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

    /** Ease the emphasized mesh back to the base size. Later frames must not snap it. */
    private releaseNearestScale(size: number): void {
        if (this.currentIndex < 0) return;

        const previous = this.currentIndex;
        this.previousIndex = previous;
        this.currentIndex = -1;
        this.tweenMeshScale(previous, size);
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
        this.pageAtTop = true;
        this.lastImageIndex = undefined;
    }

    private killScaleTweens(): void {
        for (const mesh of this.meshes) gsap.killTweensOf(mesh.scale);
    }
}
