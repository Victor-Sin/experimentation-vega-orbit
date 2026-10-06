export interface Logger {
    log: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

export function createLogger({ id, color }: { id: string; color?: string }): Logger {
    const tag = `%c[${id}]`;
    const style = `color:${color ?? '#888'}`;

    return {
        log: (...args) => console.log(tag, style, ...args),
        info: (...args) => console.info(tag, style, ...args),
        warn: (...args) => console.warn(tag, style, ...args),
        error: (...args) => console.error(tag, style, ...args)
    };
}
