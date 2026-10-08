import GUI from 'lil-gui';

import { MIN_PLANE_COUNT, type BreakpointPresetKey } from './OglWheelVega.config.ts';
import type { OglWheelVega } from './OglWheelVega.ts';

/** lil-gui parameter panel — DEV only. */
export function mountOglWheelVegaInspector(host: OglWheelVega): () => void {
    const gui = new GUI({ title: 'Cube' });
    const { planes, scroll, fisheye } = host;

    const layout = gui.addFolder('Layout');
    const animation = gui.addFolder('Animation');
    const cameraFolder = gui.addFolder('Camera');

    const refresh = () => host.syncLayout();
    const refreshView = () => {
        refresh();
        host.refreshVisiblePartScroll();
    };

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
    layout.add(planes, 'size', 0, 2, 0.01).name('Plane size').onChange(refreshView).listen();
    layout
        .add(planes.circle, 'origin', { '+X': '+x', '-X': '-x', '+Z': '+z', '-Z': '-z' })
        .name('Origin')
        .onChange(refresh)
        .listen();

    animation
        .add(host, 'nearestScale', 1, 3, 0.01)
        .name('Nearest scale')
        .onChange(refresh)
        .listen();
    animation.add(scroll, 'idleSpeed', 0, 0.2, 0.001).name('Idle speed');
    animation.add(scroll, 'influence', 0, 0.1, 0.0001).name('Scroll influence');
    animation.add(scroll, 'damping', 0.1, 20, 0.1).name('Damping');
    animation.add(scroll, 'travel', 0.5, 10, 0.1).name('Scroll travel').onChange(refresh).listen();
    animation.add(scroll, 'progress').name('Progress (debug)').listen();

    const introFolder = gui.addFolder('Intro');
    introFolder.add(host.intro, 'drop', 0.1, 3, 0.01).name('Drop duration');
    introFolder.add(host.intro, 'stagger', 0, 0.3, 0.01).name('Stagger');
    introFolder.add(host.intro, 'delay', 0, 2, 0.01).name('Delay');
    introFolder.add(host.intro, 'lift', 0, 30, 0.1).name('Lift');
    introFolder.add(host, 'replayIntro').name('Replay');

    cameraFolder
        .add(planes.circle, 'maxCircleVisiblePart', 0.1, 1.5, 0.01)
        .name('Max visible part')
        .onChange(() => host.refreshVisiblePartScroll());
    cameraFolder
        .add(planes.circle, 'visiblePartScroll', 0.1, 2, 0.01)
        .name('Visible part scroll')
        .onChange(() => host.refreshVisiblePartScroll());
    cameraFolder
        .add(planes.circle, 'translateZ', -8, 8, 0.01)
        .name('Translate Z')
        .onChange(() => host.refreshVisiblePartScroll());
    cameraFolder
        .add(planes.circle, 'orthographic')
        .name('Orthographic')
        .onChange(() => host.placeCamera())
        .listen();

    gui.addFolder('FXAA').add(fisheye, 'fxaa').name('Enabled').onChange(refresh);

    return () => gui.destroy();
}
