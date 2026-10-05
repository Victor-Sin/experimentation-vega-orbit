import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Inspector } from 'three/addons/inspector/Inspector.js';
import type { Tab } from 'three/addons/inspector/ui/Tab.js';
import {
    Fn,
    HALF_PI,
    PI2,
    cos,
    float,
    instanceIndex,
    mix,
    mod,
    positionLocal,
    screenUV,
    select,
    sin,
    uniform,
    uv,
    vec3
} from 'three/tsl';

import { $mediaStatus } from '@scripts/stores/deviceStatus';

import type { CanvasManagerClock } from '../../core/CanvasManager.ts';
import { WebgpuComponent } from '../../webgpu/WebgpuComponent.ts';

enum TypeShape {
    row = 'row',
    circle = 'circle'
}

const TypeShapeUniform = {
    row: 0,
    circle: 1
} as const;

const backgroundInner = uniform(new THREE.Color(0x2b3240));
const backgroundOuter = uniform(new THREE.Color(0x0b0d12));
/** Local cylindrical bend radius (object space X). Larger = flatter. */
const bendRadius = uniform(0.75);
/** 1 = bend amount follows layout distance (row/circle); 0 = full bend always. */
const uBendByDistance = uniform(1);

const uCount = uniform(6);
const uGap = uniform(2);
const uSize = uniform(0.25);
const uProgress = uniform(0.5);
const uType = uniform(TypeShapeUniform.row);
const uRadiusX = uniform(0);
const uRadiusY = uniform(0);
const udistanceFactor = uniform(1);

export class TslCube extends WebgpuComponent {
    static id = 'TslCube';

    /** Matches the inspector slider. InstancedMesh cannot grow past its allocated count. */
    private static readonly maxInstanceCount = 20;

    public id = TslCube.id;

    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private geometry!: THREE.PlaneGeometry;
    private material!: THREE.MeshBasicNodeMaterial;
    private mesh!: THREE.InstancedMesh;
    private controls: OrbitControls | null = null;
    private inspector: Inspector | null = null;
    private readonly indexColor = new THREE.Color();

    private readonly motion = {
        spin: true,
        speedX: 0.3,
        speedY: 0.5
    };

    private readonly instanceParameters = {
        count: 6,
        gap: 2,
        size: 1,
        type: TypeShape.row,
        circle: {
            radiusX: 0,
            radiusY: 0
        }
    };

    private readonly animationParameters = {
        easing: 'ease-in-out',
        direction: 'forward',
        loop: true,
        speed: 1,
        progress: 0.5
    };

    private readonly bendParameters = {
        byDistance: true
    };

    constructor() {
        super({ id: TslCube.id, renderer: { antialias: true, alpha: false } });
    }

    // ----------------------------------------------
    // Scene
    // ----------------------------------------------

    public override onRendererPooled(): void {
        super.onRendererPooled();
        this.setupScene();
    }

    public override onMounted(): void {
        // OrbitControls listens on the canvas, which only exists once the renderer is pooled
        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = true;
        this.controls.enablePan = false;
        this.controls.minDistance = 2;
        this.controls.maxDistance = 8;

        this.mountInspector();
    }

    public override onUnmounted(): void {
        this.controls?.dispose();
        this.controls = null;
        this.unmountInspector();
    }

    public override onResize(): void {
        if (!this.camera) return;
        this.camera.aspect = this.resolution.ratio;
        this.camera.updateProjectionMatrix();
    }

    public override onUpdate({ deltaTime }: CanvasManagerClock): void {
        if (this.motion.spin && !$mediaStatus.get().isReducedMotion) {
            // The ticker reports milliseconds
            // const seconds = deltaTime * 0.001;
            // this.mesh.rotation.x += seconds * this.motion.speedX;
            // this.mesh.rotation.y += seconds * this.motion.speedY;
        }

        this.controls?.update();
    }

    public override onRender(): void {
        this.renderer.render(this.scene, this.camera);
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
    // Private
    // ----------------------------------------------

    private setupScene(): void {
        this.scene = new THREE.Scene();
        // A node can drive the background directly, without a mesh to carry it
        this.scene.backgroundNode = mix(backgroundInner, backgroundOuter, screenUV.distance(0.5));

        this.camera = new THREE.PerspectiveCamera(45, this.resolution.ratio, 0.1, 100);
        this.camera.position.set(0, 0, 1);

        this.camera.lookAt(0, 0, 0);

        this.geometry = new THREE.PlaneGeometry(1, 1, 32, 1);

        this.material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
        this.applyPositionNode();

        this.mesh = new THREE.InstancedMesh(this.geometry, this.material, TslCube.maxInstanceCount);
        this.mesh.position.set(0, 0, 0);
        this.mesh.rotation.y = 0;
        this.scene.add(this.mesh);

        const identity = new THREE.Matrix4();
        for (let i = 0; i < TslCube.maxInstanceCount; i++) {
            this.mesh.setMatrixAt(i, identity);
        }
        this.mesh.instanceMatrix.needsUpdate = true;

        this.syncLayoutUniforms();
        this.paintIndexColors();

        this.isInitialized = true;
    }

    private disposeScene(): void {
        this.geometry?.dispose();
        this.material?.dispose();
        this.scene?.clear();
    }

    private syncLayoutUniforms(): void {
        const { count, gap, size, type, circle } = this.instanceParameters;
        const { progress } = this.animationParameters;

        uCount.value = count;
        uGap.value = gap;
        uSize.value = size;
        uProgress.value = progress;
        uType.value = type === TypeShape.circle ? TypeShapeUniform.circle : TypeShapeUniform.row;
        uRadiusX.value = circle.radiusX;
        uRadiusY.value = circle.radiusY;
        uBendByDistance.value = this.bendParameters.byDistance ? 1 : 0;

        if (this.mesh) {
            this.mesh.count = count;
        }
    }

    /**
     * Refresh GPU layout uniforms from inspector state, then colors + bounds.
     */
    private refreshLayout(): void {
        this.syncLayoutUniforms();
        this.paintIndexColors();
    }

    /**
     * Red channel only. Index 0 is 0, the last index is 255,
     * and each step adds 255 / (count - 1).
     */
    private paintIndexColors(): void {
        const { count } = this.instanceParameters;
        const step = count > 1 ? 1 / (count - 1) : 0;

        for (let i = 0; i < count; i++) {
            this.indexColor.setRGB(i * step, 0, 0);
            this.mesh.setColorAt(i, this.indexColor);
        }

        if (this.mesh.instanceColor) {
            this.mesh.instanceColor.needsUpdate = true;
        }
    }

    /**
     * Local cylindrical bend + per-instance layout offset, all in the vertex stage.
     * Instance matrices stay identity; scale is applied here via uSize.
     */
    private applyPositionNode(): void {
        this.material.positionNode = Fn(() => {
            const i = float(instanceIndex);
            const isCircle = uType.equal(TypeShapeUniform.circle);

            // Row: wrap along X
            const totalWidth = uCount.mul(uGap);
            const halfWidth = totalWidth.div(2);
            const translateX = uProgress.mul(2).sub(1).mul(totalWidth).mul(3);
            const rawX = i.negate().mul(uGap).add(translateX);
            const wrappedX = mod(rawX.add(halfWidth), totalWidth).sub(halfWidth);
            const rowOffset = vec3(wrappedX, 0, 0);
            const rowDistance = wrappedX.abs();

            // Circle: index 0 at (0, -Z); progress rotates toward +X
            const progressAngle = uProgress.mul(PI2);
            const radiusX = uRadiusX.add(uGap);
            const radiusZ = uRadiusY.add(uGap);
            const angle = HALF_PI.negate().sub(i.div(uCount).mul(PI2)).add(progressAngle);
            const baseOffset = vec3(0, 0, radiusZ.negate());
            const circleOffset = vec3(cos(angle).mul(radiusX), 0, sin(angle).mul(radiusZ));
            const distanceCircle = baseOffset.distance(circleOffset);

            const offset = select(isCircle, circleOffset, rowOffset);

            // Distance amount adapts to mode: |x|/halfWidth (row) or front chord (circle)
            const maxDistance = select(isCircle, float(2).mul(radiusX.max(radiusZ)), halfWidth);
            const distanceAmount = select(isCircle, distanceCircle, rowDistance)
                .div(maxDistance.max(1e-5))
                .clamp(0, 1);
            // Toggle: by-distance (mode-aware) vs full bend everywhere
            const amount = select(uBendByDistance.equal(1), distanceAmount, float(1)).mul(
                udistanceFactor
            );

            // X/Y stay flat (stable scale); only Z curvature is driven by amount
            const uvX = uv().x.sub(0.5);
            const theta = uvX.div(bendRadius);
            const bendZ = float(1).sub(cos(theta)).mul(bendRadius).mul(amount).negate();
            const shaped = vec3(uvX, positionLocal.y, bendZ.negate());

            return shaped.mul(uSize).add(offset);
        })();
    }

    private mountInspector(): void {
        if (this.inspector) return;

        const inspector = new Inspector();
        this.renderer.inspector = inspector;
        this.inspector = inspector;

        const parameters = inspector.createParameters('Cube');

        const refreshLayout = () => this.refreshLayout();

        parameters
            .add(this.instanceParameters, 'count', 6, TslCube.maxInstanceCount, 1)
            .name('Instance count')
            .onChange(refreshLayout);
        parameters
            .add(this.instanceParameters, 'gap', 0, 5, 0.1)
            .name('Instance gap')
            .onChange(refreshLayout);
        parameters
            .add(this.instanceParameters, 'size', 0, 2, 0.01)
            .name('Instance size')
            .onChange(refreshLayout);
        // A select needs an options object. Two extra strings are ignored and the control stays a text field.
        const radiusX = parameters
            .add(this.instanceParameters.circle, 'radiusX', 0, 1, 0.01)
            .name('Circle radius X')
            .onChange(refreshLayout)
            .hide();

        const radiusY = parameters
            .add(this.instanceParameters.circle, 'radiusY', 0, 1, 0.01)
            .name('Circle radius Y')
            .onChange(refreshLayout)
            .hide();

        parameters
            .add(this.animationParameters, 'progress', 0, 1, 0.01)
            .name('Progress')
            .onChange(refreshLayout);

        const bend = { radius: bendRadius.value as number };
        parameters
            .add(bend, 'radius', 0.15, 10, 0.01)
            .name('Bend radius')
            .onChange((value: number) => {
                bendRadius.value = value;
            });

        const distanceFactor = { factor: udistanceFactor.value as number };
        parameters
            .add(distanceFactor, 'factor', 0, 2, 0.01)
            .name('Distance bend factor')
            .onChange((value: number) => {
                udistanceFactor.value = value;
            });

        parameters
            .add(this.bendParameters, 'byDistance')
            .name('Bend by distance')
            .onChange((value: boolean) => {
                this.bendParameters.byDistance = value;
                uBendByDistance.value = value ? 1 : 0;
            });

        parameters
            .add(this.instanceParameters, 'type', {
                Row: TypeShape.row,
                Circle: TypeShape.circle
            })
            .name('Instance type')
            .onChange((type: TypeShape) => {
                refreshLayout();
                if (type === TypeShape.circle) {
                    radiusX.show();
                    radiusY.show();
                } else {
                    radiusX.hide();
                    radiusY.hide();
                }
            });

        const withTabs = inspector as Inspector & { parameters: Tab };
        inspector.setActiveTab(withTabs.parameters);
    }
}
