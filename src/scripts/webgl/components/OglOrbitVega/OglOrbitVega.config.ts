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

/** Responsive layout presets (`desktop` = default; xs/sm/md from debugger screenshots). */
export type BreakpointPresetKey = 'xs' | 'sm' | 'md' | 'desktop';

export const DEFAULT_BREAKPOINT: BreakpointPresetKey = 'desktop';

export const BREAKPOINT_PRESETS: Record<BreakpointPresetKey, ShapePreset> = {
    xs: {
        gap: 0.52,
        size: 0.35,
        bend: { enabled: true, radius: 0.34, distanceFactor: 1, byDistance: true },
        cameraOffset: { zOffset: 0.01 },
        fisheye: { enabled: true, effect: -0.5, scale: 1.54 },
        circle: { radiusX: 1.35, radiusY: 2.31, faceInward: true }
    },
    sm: {
        gap: 0.56,
        size: 0.38,
        bend: { enabled: true, radius: 0.34, distanceFactor: 1, byDistance: true },
        cameraOffset: { zOffset: 0.01 },
        fisheye: { enabled: true, effect: -0.5, scale: 1.54 },
        circle: { radiusX: 1.35, radiusY: 2.31, faceInward: true }
    },
    md: {
        gap: 0.51,
        size: 0.38,
        bend: { enabled: true, radius: 0.34, distanceFactor: 1, byDistance: true },
        cameraOffset: { zOffset: 0.01 },
        fisheye: { enabled: true, effect: -0.5, scale: 1.54 },
        circle: { radiusX: 1.35, radiusY: 2.04, faceInward: true }
    },
    desktop: {
        gap: DEFAULT_PRESET.gap,
        size: DEFAULT_PRESET.size,
        bend: { ...DEFAULT_PRESET.bend },
        cameraOffset: { ...DEFAULT_PRESET.cameraOffset },
        fisheye: { ...DEFAULT_PRESET.fisheye },
        circle: { ...DEFAULT_PRESET.circle }
    }
};
