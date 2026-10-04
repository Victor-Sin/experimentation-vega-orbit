export interface UseResizeInstance {
    width: number;
    height: number;
    stop: () => void;
}

export interface UseDPRInstance {
    stop: () => void;
}

export interface UseScreenInstance {
    width: number;
    height: number;
    dpr: number;
    stop: () => void;
}

export function useResize(
    element: HTMLElement,
    options: { onDebouncedUpdate: (size: UseResizeInstance) => void }
): UseResizeInstance {
    let width = element.clientWidth;
    let height = element.clientHeight;
    let frame = 0;
    let observer: ResizeObserver;

    const instance: UseResizeInstance = {
        get width() {
            return width;
        },
        get height() {
            return height;
        },
        stop() {
            observer.disconnect();
            cancelAnimationFrame(frame);
        }
    };

    observer = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (!box) return;
        width = box.width;
        height = box.height;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => options.onDebouncedUpdate(instance));
    });

    observer.observe(element);
    return instance;
}

export function useDPR(onChange: (dpr: number) => void): UseDPRInstance {
    let query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);

    const listen = () => {
        query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        query.addEventListener('change', onMediaChange);
        onChange(window.devicePixelRatio);
    };

    const onMediaChange = () => {
        query.removeEventListener('change', onMediaChange);
        listen();
    };

    query.addEventListener('change', onMediaChange);

    return {
        stop() {
            query.removeEventListener('change', onMediaChange);
        }
    };
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
