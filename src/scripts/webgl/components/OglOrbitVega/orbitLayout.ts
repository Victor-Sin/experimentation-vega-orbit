/**
 * Map a plane onto a centered strip of width `totalWidth`, wrapping with modulo.
 *
 * Why `%`: a finite set of meshes must feel like an infinite carousel. When a
 * plane slides off one edge, it reappears on the other — no cloning, no gaps.
 * Period = `totalWidth` (= `count * gap`). Scroll only shifts phase via `translateX`.
 */
export function wrapRowX(
    index: number,
    gap: number,
    translateX: number,
    totalWidth: number
): number {
    const half = totalWidth / 2;
    // Unwrapped position on an infinite line (scroll shifts the whole strip).
    const raw = -index * gap + translateX;

    // Shift into [0, totalWidth), wrap, then shift back to [-half, +half].
    // The `+ totalWidth` before the 2nd `%` fixes JS negative-modulo (`-1 % 5 === -1`).
    return ((((raw + half) % totalWidth) + totalWidth) % totalWidth) - half;
}

/**
 * Project a wrapped 1D X onto a fixed XZ ellipse (front at -Z).
 * Wrap first in 1D, then map to angle so scroll never blows angles past the arc.
 * Gap stays stable vs plane count (angle from arc length, not from index alone).
 */
export function circleOffset(
    wrappedX: number,
    radiusX: number,
    radiusY: number
): { x: number; y: number; z: number } {
    // Mean radius ≈ arc-length scale so angle ≈ wrappedX / radius.
    const arc = Math.max((radiusX + radiusY) * 0.5, 1e-5);
    // -π/2 puts the strip center at the front (-Z).
    const angle = -Math.PI / 2 + wrappedX / arc;

    return {
        x: Math.cos(angle) * radiusX,
        y: 0,
        z: Math.sin(angle) * radiusY
    };
}
