export interface UseScreenInstance {
    width: number;
    height: number;
    dpr: number;
    stop: () => void;
}

export function useScreen(options: {
    onDebouncedUpdate: (size: UseScreenInstance) => void;
}): UseScreenInstance {
    let width = window.innerWidth;
    let height = window.innerHeight;
    let dpr = window.devicePixelRatio;
    let frame = 0;

    const instance: UseScreenInstance = {
        get width() {
            return width;
        },
        get height() {
            return height;
        },
        get dpr() {
            return dpr;
        },
        stop() {
            window.removeEventListener('resize', onResize);
            cancelAnimationFrame(frame);
        }
    };

    const publish = () => {
        width = window.innerWidth;
        height = window.innerHeight;
        dpr = window.devicePixelRatio;
        options.onDebouncedUpdate(instance);
    };

    const onResize = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(publish);
    };

    window.addEventListener('resize', onResize);

    return instance;
}
