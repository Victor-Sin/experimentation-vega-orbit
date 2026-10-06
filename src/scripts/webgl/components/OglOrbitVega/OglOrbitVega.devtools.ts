import GUI from 'lil-gui';

import { MIN_PLANE_COUNT, ShapeType, type BreakpointPresetKey } from './OglOrbitVega.config.ts';
import type { OglOrbitVega } from './OglOrbitVega.ts';

/** lil-gui parameter panel — DEV only. */
export function mountOglOrbitVegaInspector(host: OglOrbitVega): () => void {
    const gui = new GUI({ title: 'Cube' });
    const { planes, scroll, bend, cameraOffset, fisheye } = host;

    const layout = gui.addFolder('Layout');
    const circle = gui.addFolder('Circle');
    const animation = gui.addFolder('Animation');
    const bendFolder = gui.addFolder('Bend');
    const cameraFolder = gui.addFolder('Camera');
    const postFolder = gui.addFolder('Fisheye');

    const refresh = () => host.syncLayout();
    const refreshView = () => {
        refresh();
        host.placeCamera();
    };

    const radiusX = circle
        .add(planes.circle, 'radiusX', 0.2, 3, 0.01)
        .name('Radius X')
        .onChange(refreshView);
    const radiusY = circle
        .add(planes.circle, 'radiusY', 0.2, 3, 0.01)
        .name('Radius Y')
        .onChange(refreshView);
    const faceInward = circle
        .add(planes.circle, 'faceInward')
        .name('Face inward')
        .onChange(refresh);

    if (planes.type !== ShapeType.circle) {
        radiusX.hide();
        radiusY.hide();
        faceInward.hide();
    }

    layout
        .add(host, 'breakpoint', {
            Desktop: 'desktop',
            'max-xs': 'xs',
            'max-sm': 'sm',
            'max-md': 'md'
        })
        .name('Breakpoint')
        .onChange((key: BreakpointPresetKey) => host.applyBreakpointPreset(key))
        .listen();

    layout
        .add(planes, 'count', MIN_PLANE_COUNT, planes.count, 1)
        .name('Plane count')
        .onChange(refreshView)
        .listen();
    layout.add(planes, 'gap', 0, 1, 0.01).name('Plane gap').onChange(refreshView).listen();
    layout.add(planes, 'size', 0, 2, 0.01).name('Plane size').onChange(refresh).listen();
    layout
        .add(planes, 'type', { Row: ShapeType.row, Circle: ShapeType.circle })
        .name('Plane type')
        .onChange((type: ShapeType) => {
            host.applyShapePreset(type);
            const show = type === ShapeType.circle;
            radiusX.show(show);
            radiusY.show(show);
            faceInward.show(show);
        });

    radiusX.listen();
    radiusY.listen();
    faceInward.listen();

    animation.add(scroll, 'idleSpeed', 0, 0.2, 0.001).name('Idle speed');
    animation.add(scroll, 'influence', 0, 0.1, 0.0001).name('Scroll influence');
    animation.add(scroll, 'damping', 0.1, 20, 0.1).name('Damping');
    animation.add(scroll, 'travel', 0.5, 10, 0.1).name('Scroll travel').onChange(refresh).listen();
    animation.add(scroll, 'progress').name('Progress (debug)').listen();

    bendFolder.add(bend, 'enabled').name('Enabled').onChange(refresh).listen();
    bendFolder.add(bend, 'radius', 0.15, 10, 0.01).name('Bend radius').onChange(refresh).listen();
    bendFolder
        .add(bend, 'distanceFactor', 0, 2, 0.01)
        .name('Distance bend factor')
        .onChange(refresh)
        .listen();
    bendFolder.add(bend, 'byDistance').name('Bend by distance').onChange(refresh).listen();

    cameraFolder
        .add(cameraOffset, 'zOffset', -5, 5, 0.01)
        .name('Z offset')
        .onChange(() => host.placeCamera())
        .listen();

    postFolder.add(fisheye, 'enabled').name('Enabled').onChange(refresh).listen();
    postFolder
        .add(fisheye, 'effect', -1, 1, 0.01)
        .name('Effect (− barrel / + pinch)')
        .onChange(refresh)
        .listen();
    postFolder.add(fisheye, 'scale', 0.1, 2, 0.01).name('Scale').onChange(refresh).listen();
    gui.addFolder('FXAA').add(fisheye, 'fxaa').name('Enabled').onChange(refresh);

    return () => gui.destroy();
}
