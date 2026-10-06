import { Inspector } from 'three/addons/inspector/Inspector.js';
import type { Tab } from 'three/addons/inspector/ui/Tab.js';
import type { WebGPURenderer } from 'three/webgpu';

import { TypeShape } from './TslCube.config.ts';

type UniformNumber = { value: number };

/** Narrow host surface for the DEV inspector — keep out of the production path. */
export type TslCubeDevtoolsApi = {
    renderer: WebGPURenderer;
    limits: { minPlaneCount: number; maxPlaneCount: number };
    planeParameters: {
        count: number;
        gap: number;
        size: number;
        type: TypeShape;
        circle: { radiusX: number; radiusY: number; faceInward: boolean };
    };
    scroll: {
        progress: number;
        idleSpeed: number;
        influence: number;
        damping: number;
    };
    bendParameters: {
        enabled: boolean;
        radius: number;
        distanceFactor: number;
        byDistance: boolean;
    };
    cameraParameters: { zOffset: number };
    postParameters: { enabled: boolean; effect: number; scale: number };
    uniforms: {
        bendRadius: UniformNumber;
        uBendByDistance: UniformNumber;
        udistanceFactor: UniformNumber;
        uBendEnabled: UniformNumber;
        uFisheyeEnabled: UniformNumber;
        uFisheyeEffect: UniformNumber;
        uFisheyeScale: UniformNumber;
    };
    applyShapePreset: (type: TypeShape) => void;
    syncLayout: () => void;
    applyCameraOffset: () => void;
};

/** Three.js Inspector UI — DEV only; production never imports this module. */
export function mountTslCubeInspector(api: TslCubeDevtoolsApi): () => void {
    const inspector = new Inspector();
    api.renderer.inspector = inspector;

    const {
        planeParameters,
        scroll,
        bendParameters,
        cameraParameters,
        postParameters,
        uniforms,
        limits
    } = api;

    const parameters = inspector.createParameters('Cube');

    const refreshLayout = () => api.syncLayout();
    const refreshCircleShape = () => {
        refreshLayout();
        api.applyCameraOffset();
    };

    const layout = parameters.addFolder('Layout');
    const circle = parameters.addFolder('Circle');
    const animation = parameters.addFolder('Animation');
    const bendFolder = parameters.addFolder('Bend');
    const cameraFolder = parameters.addFolder('Camera');

    const radiusX = circle
        .add(planeParameters.circle, 'radiusX', 0.2, 3, 0.01)
        .name('Radius X')
        .onChange(refreshCircleShape);
    const radiusY = circle
        .add(planeParameters.circle, 'radiusY', 0.2, 3, 0.01)
        .name('Radius Y')
        .onChange(refreshCircleShape);
    const faceInward = circle
        .add(planeParameters.circle, 'faceInward')
        .name('Face inward')
        .onChange(refreshLayout);

    if (planeParameters.type !== TypeShape.circle) {
        radiusX.hide();
        radiusY.hide();
        faceInward.hide();
    }

    layout
        .add(planeParameters, 'count', limits.minPlaneCount, limits.maxPlaneCount, 1)
        .name('Plane count')
        .onChange(refreshCircleShape)
        .listen();
    layout
        .add(planeParameters, 'gap', 0, 1, 0.01)
        .name('Plane gap')
        .onChange(refreshCircleShape)
        .listen();
    layout
        .add(planeParameters, 'size', 0, 2, 0.01)
        .name('Plane size')
        .onChange(refreshLayout)
        .listen();
    layout
        .add(planeParameters, 'type', {
            Row: TypeShape.row,
            Circle: TypeShape.circle
        })
        .name('Plane type')
        .onChange((type: TypeShape) => {
            api.applyShapePreset(type);
            if (type === TypeShape.circle) {
                radiusX.show();
                radiusY.show();
                faceInward.show();
            } else {
                radiusX.hide();
                radiusY.hide();
                faceInward.hide();
            }
        });

    radiusX.listen();
    radiusY.listen();
    faceInward.listen();

    animation.add(scroll, 'idleSpeed', 0, 0.2, 0.001).name('Idle speed');
    animation.add(scroll, 'influence', 0, 0.1, 0.0001).name('Scroll influence');
    animation.add(scroll, 'damping', 0.1, 20, 0.1).name('Damping');
    animation.add(scroll, 'progress').name('Progress (debug)');

    bendFolder
        .add(bendParameters, 'enabled')
        .name('Enabled')
        .onChange((value: boolean) => {
            bendParameters.enabled = value;
            uniforms.uBendEnabled.value = value ? 1 : 0;
        })
        .listen();
    bendFolder
        .add(bendParameters, 'radius', 0.15, 10, 0.01)
        .name('Bend radius')
        .onChange((value: number) => {
            uniforms.bendRadius.value = value;
        })
        .listen();
    bendFolder
        .add(bendParameters, 'distanceFactor', 0, 2, 0.01)
        .name('Distance bend factor')
        .onChange((value: number) => {
            uniforms.udistanceFactor.value = value;
        })
        .listen();
    bendFolder
        .add(bendParameters, 'byDistance')
        .name('Bend by distance')
        .onChange((value: boolean) => {
            bendParameters.byDistance = value;
            uniforms.uBendByDistance.value = value ? 1 : 0;
        })
        .listen();

    cameraFolder
        .add(cameraParameters, 'zOffset', -5, 5, 0.01)
        .name('Z offset')
        .onChange(() => api.applyCameraOffset())
        .listen();

    const postFolder = parameters.addFolder('Fisheye');
    postFolder
        .add(postParameters, 'enabled')
        .name('Enabled')
        .onChange((value: boolean) => {
            postParameters.enabled = value;
            uniforms.uFisheyeEnabled.value = value ? 1 : 0;
        })
        .listen();
    postFolder
        .add(postParameters, 'effect', -1, 1, 0.01)
        .name('Effect (− barrel / + pinch)')
        .onChange((value: number) => {
            postParameters.effect = value;
            uniforms.uFisheyeEffect.value = value;
        })
        .listen();
    postFolder
        .add(postParameters, 'scale', 0.1, 2, 0.01)
        .name('Scale')
        .onChange((value: number) => {
            postParameters.scale = value;
            uniforms.uFisheyeScale.value = value;
        })
        .listen();

    const withTabs = inspector as Inspector & { parameters: Tab };
    inspector.setActiveTab(withTabs.parameters);

    return () => {
        inspector.dispose();
    };
}
