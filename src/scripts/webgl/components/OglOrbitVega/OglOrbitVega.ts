import { Program, Vec3 } from 'ogl';

import colorspaceParsFragment from '../../chunks/colorspace_pars_fragment.glsl?raw';
import {
    OglVegaCarousel,
    type BreakpointPresetKey,
    type PlaneGeometrySpec,
    type SharedLayoutPreset
} from '../OglVegaCarousel/OglVegaCarousel.ts';

import {
    BREAKPOINT_PRESETS,
    DEFAULT_PRESET,
    DEFAULT_SHAPE,
    MIN_PLANE_COUNT,
    SHAPE_PRESETS,
    ShapeType,
    type ShapePreset
} from './OglOrbitVega.config.ts';
import { circleOffset, wrapRowX } from './orbitLayout.ts';

import fisheyeFragment from './fisheye.frag?raw';
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
export class OglOrbitVega extends OglVegaCarousel {
    static id = 'OglOrbitVega';

    protected override get minPlaneCount(): number {
        return MIN_PLANE_COUNT;
    }

    public planes = {
        count: MIN_PLANE_COUNT,
        gap: DEFAULT_PRESET.gap,
        size: DEFAULT_PRESET.size,
        type: DEFAULT_SHAPE,
        circle: { ...DEFAULT_PRESET.circle }
    };

    public bend = { ...DEFAULT_PRESET.bend };
    public cameraOffset = { zOffset: DEFAULT_PRESET.cameraOffset.zOffset };
    public override fisheye = { ...DEFAULT_PRESET.fisheye, fxaa: true };
    public override scroll = { ...DEFAULT_PRESET.scroll, progress: 0 };

    private readonly distances: { value: number }[] = [];
    private readonly offset = new Vec3();
    private stagedDistance: { value: number } = { value: 0 };

    constructor() {
        super();

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

    protected override presetFor(key: BreakpointPresetKey) {
        return BREAKPOINT_PRESETS[key];
    }

    protected override applyBreakpointExtras(preset: SharedLayoutPreset): void {
        const full = preset as ShapePreset;
        Object.assign(this.bend, full.bend);
        this.cameraOffset.zOffset = full.cameraOffset.zOffset;
        Object.assign(this.fisheye, full.fisheye);
    }

    protected override planeGeometry(): PlaneGeometrySpec {
        return { width: 1, height: 1, widthSegments: 8, heightSegments: 1 };
    }

    protected override createMeshProgram(_index: number, url: string | undefined): Program {
        const uDistance = { value: 0 };
        this.stagedDistance = uDistance;

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
                ...this.planeTextureUniforms(url)
            }
        });
    }

    protected override onMeshCreated(index: number): void {
        this.distances[index] = this.stagedDistance;
    }

    protected override disposeMeshPrograms(): void {
        for (const mesh of this.meshes) this.deleteProgram(mesh.program);
    }

    protected override prepareRebuild(): void {
        this.distances.length = 0;
    }

    protected override onMeshesDisposed(): void {
        this.distances.length = 0;
    }

    protected override syncFromScroll(): void {
        this.syncLayout();
    }

    protected override syncPostUniforms(): void {
        super.syncPostUniforms();
        this.uniforms.uBendRadius.value = this.bend.radius;
        this.uniforms.uBendByDistance.value = this.bend.byDistance ? 1 : 0;
        this.uniforms.uDistanceFactor.value = this.bend.distanceFactor;
        this.uniforms.uBendEnabled.value = this.bend.enabled ? 1 : 0;
        this.uniforms.uFisheyeEnabled.value = this.fisheye.enabled ? 1 : 0;
        this.uniforms.uFisheyeEffect.value = this.fisheye.effect;
        this.uniforms.uFisheyeScale.value = this.fisheye.scale;
    }

    protected override updateCameraOnResize(): void {
        this.camera.perspective({ aspect: this.resolution.ratio });
    }

    protected override addPostPasses(): void {
        this.post.addPass({
            fragment: fisheyeSource,
            uniforms: {
                uFisheyeEnabled: this.uniforms.uFisheyeEnabled,
                uFisheyeEffect: this.uniforms.uFisheyeEffect,
                uFisheyeScale: this.uniforms.uFisheyeScale
            }
        });
    }

    public override syncLayout(): void {
        this.syncPostUniforms();

        const { gap, size, type, circle } = this.planes;
        const count = this.visibleCount();
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

        this.planes.type = type;
        this.applySharedLayout(preset);
        this.applyBreakpointExtras(preset);
        this.commitView();
    }

    public override placeCamera(): void {
        if (!this.camera) return;

        const z = this.cameraOffset.zOffset;
        this.camera.position.set(0, 0, z);
        this.camera.lookAt([0, 0, z - 1]);
    }

    protected override async mountDevtools(): Promise<void> {
        const { mountOglOrbitVegaInspector } = await import('./OglOrbitVega.devtools.ts');
        this._unmountDevtools?.();
        this._unmountDevtools = mountOglOrbitVegaInspector(this);
    }
}
