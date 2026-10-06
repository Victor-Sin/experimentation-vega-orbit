export function createUUID(): string {
    return crypto.randomUUID();
}

export function lcfirst(value: string): string {
    return value.charAt(0).toLowerCase() + value.slice(1);
}

export function hash(value: string): string {
    let h = 0;
    for (let i = 0; i < value.length; i++) {
        h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}
