/**
 * Closed ring in the XZ plane.
 * `size` is the plane width along the arc, `gap` the empty space between edges.
 * Centers sit on radius R so the pitch `size + gap` tiles the circumference.
 */
export function circleRadius(count: number, size: number, gap: number): number {
    const pitch = size + gap;
    return (Math.max(count, 1) * pitch) / (2 * Math.PI);
}

/** Outer width of the ring, including the plane extent past the center radius. */
export function circleOuterDiameter(radius: number, size: number): number {
    return 2 * radius + size;
}

/**
 * Perspective camera height so a world width `diameter` fills `visiblePart` of the canvas width.
 * use TOH formula from trigonometry, H = O / tan(fov/2), multiply by visiblePart to get
 * OGL fov is vertical: visibleWidth = 2 * h * tan(fov/2) * aspect.
 */
export function perspectiveHeight(
    diameter: number,
    visiblePart: number,
    fovDegrees: number,
    aspect: number
): number {
    const fovY = (fovDegrees * Math.PI) / 180;
    const tanHalf = Math.tan(fovY / 2);
    return diameter / (2 * visiblePart * tanHalf * aspect);
}

/**
 * Angle of mesh `index` on the ring.
 * Index 0 sits on `angleOffset` (the chosen axis when scroll is 0).
 * Increasing index walks counter-clockwise when seen from above.
 */
export function planeAngle(index: number, count: number, angleOffset: number): number {
    const safeCount = Math.max(count, 1);
    return angleOffset - (index * Math.PI * 2) / safeCount;
}

/**
 * Place one plane on the ring.
 * The mesh starts as an XY quad (normal +Z). rotationX lays it on XZ facing +Y.
 * rotationY yaws so the image bottom (local −Y) points at the origin (YXZ Euler: Ry * Rx).
 */
export function circlePlane(
    index: number,
    count: number,
    radius: number,
    angleOffset: number
): {
    x: number;
    y: number;
    z: number;
    rotationX: number;
    rotationY: number;
} {
    const angle = planeAngle(index, count, angleOffset);

    return {
        x: Math.cos(angle) * radius,
        y: 0,
        z: Math.sin(angle) * radius,
        rotationX: -Math.PI / 2,
        rotationY: -Math.PI / 2 - angle
    };
}
