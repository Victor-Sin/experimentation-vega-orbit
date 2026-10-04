import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Inspector } from 'three/addons/inspector/Inspector.js';
import type { Tab } from 'three/addons/inspector/ui/Tab.js';
import { mix, screenUV, uniform } from 'three/tsl';

import { $mediaStatus } from '@scripts/stores/deviceStatus';

import type { CanvasManagerClock } from '../../core/CanvasManager.ts';
import { WebgpuComponent } from '../../webgpu/WebgpuComponent.ts';

enum TypeShape {
    row = 'row',
    circle = 'circle'
}

const backgroundInner = uniform(new THREE.Color(0x2b3240));
const backgroundOuter = uniform(new THREE.Color(0x0b0d12));
const yAxis = new THREE.Vector3(0, 1, 0);

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
    private dummyMesh!: THREE.Object3D;
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
        size: 0.25,
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
        progress: 0
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

        // Unit quad: instance size is a scale on the matrix, so the slider can change it live
        this.geometry = new THREE.PlaneGeometry(1, 1);

        this.material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });

        this.dummyMesh = new THREE.Object3D();

        this.mesh = new THREE.InstancedMesh(this.geometry, this.material, TslCube.maxInstanceCount);
        this.scene.add(this.mesh);

        this.updateInstances();

        this.isInitialized = true;
    }

    private disposeScene(): void {
        this.geometry?.dispose();
        this.material?.dispose();
        this.scene?.clear();
    }

    private updateInstances(): void {
        const { count, size, type } = this.instanceParameters;

        this.mesh.count = count;
        this.dummyMesh.scale.set(size, size, 1);

        // Le mesh global reste fixe à l'origine (0, 0, 0)
        this.mesh.position.set(0, 0, 0);

        if (type === TypeShape.circle) {
            this.updateCircle();
        } else {
            this.updateRow();
        }

        this.paintIndexColors();
        this.mesh.instanceMatrix.needsUpdate = true;
        this.mesh.computeBoundingSphere();
    }

    private updateRow(): void {
        const { count, gap } = this.instanceParameters;
        const { progress } = this.animationParameters;

        this.mesh.rotation.y = 0;
        this.dummyMesh.quaternion.identity();

        const totalWidth = count * gap;
        const halfWidth = totalWidth / 2;
        const translateX = Math.sin(progress * Math.PI * 2) * halfWidth;

        for (let i = 0; i < count; i++) {
            const rawX = i * gap + translateX;

            // First add tmp offset to the rawX to avoid negative values then take the modulo
            let wrappedX = (rawX + halfWidth) % totalWidth;
            if (wrappedX < 0) {
                // If the wrappedX is negative, add the totalWidth to it to make it positive
                wrappedX += totalWidth;
            }
            // Then subtract the halfWidth to center the wrappedX
            wrappedX -= halfWidth;

            this.placeInstance(i, wrappedX, 0, 0);
        }
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

    private placeInstance(index: number, x: number, y: number, z: number): void {
        this.dummyMesh.position.set(x, y, z);
        this.dummyMesh.updateMatrix();
        this.mesh.setMatrixAt(index, this.dummyMesh.matrix);
    }

    private updateCircle(): void {
        const { count, gap, circle } = this.instanceParameters;
        const { progress } = this.animationParameters;

        this.mesh.rotation.y = 0;
        this.dummyMesh.quaternion.setFromAxisAngle(yAxis, Math.PI);

        const turn = progress * Math.PI * 2;
        const cosTurn = Math.cos(turn);
        const sinTurn = Math.sin(turn);

        for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2;
            const x = Math.cos(angle) * (circle.radiusX + gap);
            const z = Math.sin(angle) * (circle.radiusY + gap);
            this.placeInstance(i, x * cosTurn + z * sinTurn, 0, -x * sinTurn + z * cosTurn);
        }
    }

    private mountInspector(): void {
        if (this.inspector) return;

        const inspector = new Inspector();
        this.renderer.inspector = inspector;
        this.inspector = inspector;

        const parameters = inspector.createParameters('Cube');

        const refreshInstances = () => this.updateInstances();

        parameters
            .add(this.instanceParameters, 'count', 6, TslCube.maxInstanceCount, 1)
            .name('Instance count')
            .onChange(refreshInstances);
        parameters
            .add(this.instanceParameters, 'gap', 0, 5, 0.1)
            .name('Instance gap')
            .onChange(refreshInstances);
        parameters
            .add(this.instanceParameters, 'size', 0, 1, 0.01)
            .name('Instance size')
            .onChange(refreshInstances);
        // A select needs an options object. Two extra strings are ignored and the control stays a text field.
        const radiusX = parameters
            .add(this.instanceParameters.circle, 'radiusX', 0, 1, 0.01)
            .name('Circle radius X')
            .onChange(refreshInstances)
            .hide();

        const radiusY = parameters
            .add(this.instanceParameters.circle, 'radiusY', 0, 1, 0.01)
            .name('Circle radius Y')
            .onChange(refreshInstances)
            .hide();

        parameters
            .add(this.animationParameters, 'progress', 0, 1, 0.01)
            .name('Progress')
            .onChange(refreshInstances);

        parameters
            .add(this.instanceParameters, 'type', {
                Row: TypeShape.row,
                Circle: TypeShape.circle
            })
            .name('Instance type')
            .onChange((type: TypeShape) => {
                refreshInstances();
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

        // Three appends the inspector inside the canvas, which sits in a scrolled,
        // clipped box. Pin it to the viewport and force the panel open.
        this.placeInspector(inspector);
        requestAnimationFrame(() => this.placeInspector(inspector));
    }

    private placeInspector(inspector: Inspector): void {
        const root = inspector.domElement;
        if (root.parentElement !== document.body) {
            document.body.appendChild(root);
        }

        root.style.position = 'fixed';
        root.style.inset = '0';
        root.style.zIndex = '1000';

        root.querySelector('.profiler-panel')?.classList.add('visible');
        root.querySelector('.profiler-toggle')?.classList.add('panel-open');
    }

    private unmountInspector(): void {
        if (!this.inspector) return;

        this.renderer.inspector = new THREE.InspectorBase();
        this.inspector = null;
    }
}
