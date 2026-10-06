export enum ShapeType {
    row = 'row',
    circle = 'circle'
}

export type ShapePreset = {
    gap: number;
    size: number;
    bend: {
        enabled: boolean;
        radius: number;
        distanceFactor: number;
        byDistance: boolean;
    };
    cameraOffset: { zOffset: number };
    fisheye: {
        enabled: boolean;
        effect: number;
        scale: number;
    };
    circle: {
        radiusX: number;
        radiusY: number;
        faceInward: boolean;
    };
};

/** Base values per plane type. Circle = production default; Row = layout alternate. */
export const SHAPE_PRESETS: Record<ShapeType, ShapePreset> = {
    [ShapeType.circle]: {
        gap: 0.6,
        size: 0.44,
        bend: { enabled: true, radius: 0.34, distanceFactor: 1, byDistance: true },
        cameraOffset: { zOffset: 0.01 },
        fisheye: { enabled: true, effect: -0.5, scale: 1.54 },
        circle: { radiusX: 1.35, radiusY: 1.82, faceInward: true }
    },
    [ShapeType.row]: {
        gap: 0.51,
        size: 0.44,
        bend: { enabled: true, radius: 4.77, distanceFactor: 1, byDistance: true },
        cameraOffset: { zOffset: 1.51 },
        fisheye: { enabled: true, effect: -0.39, scale: 1.61 },
        circle: { radiusX: 1.35, radiusY: 1.55, faceInward: true }
    }
};

export const DEFAULT_SHAPE = ShapeType.circle;
export const DEFAULT_PRESET = SHAPE_PRESETS[DEFAULT_SHAPE];

export const MIN_PLANE_COUNT = 6;
