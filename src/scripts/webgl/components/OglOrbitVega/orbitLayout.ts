/**
 * Wrap a plane index onto a centered strip of width `totalWidth`.
 */
export function wrapRowX(
    index: number,
    gap: number,
    translateX: number,
    totalWidth: number
): number {
    const half = totalWidth / 2;
    const raw = -index * gap + translateX;
    return ((((raw + half) % totalWidth) + totalWidth) % totalWidth) - half;
}

/**
 * Project a wrapped row X onto a fixed XZ ellipse (front at -Z).
 * Gap stays stable vs plane count.
 */
export function circleOffset(
    wrappedX: number,
    radiusX: number,
    radiusY: number
): { x: number; y: number; z: number } {
    const arc = Math.max((radiusX + radiusY) * 0.5, 1e-5);
    const angle = -Math.PI / 2 + wrappedX / arc;

    return {
        x: Math.cos(angle) * radiusX,
        y: 0,
        z: Math.sin(angle) * radiusY
    };
}
