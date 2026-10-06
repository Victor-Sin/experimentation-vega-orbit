export interface UseDPRInstance {
    stop: () => void;
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
