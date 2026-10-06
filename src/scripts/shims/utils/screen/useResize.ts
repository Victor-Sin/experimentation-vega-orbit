export interface UseResizeInstance {
    width: number;
    height: number;
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
