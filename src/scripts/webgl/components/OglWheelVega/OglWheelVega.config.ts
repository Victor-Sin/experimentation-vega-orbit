export type LayoutPreset = {
    gap: number;
    size: number;
    fisheye: {
        enabled: boolean;
        effect: number;
        scale: number;
    };
    circle: {
        /** Fraction of the canvas width filled by the ring's outer diameter. `0.7` = 70%. */
        circleVisiblePart: number;
        orthographic: boolean;
    };
};

export const DEFAULT_PRESET: LayoutPreset = {
    gap: 0.6,
    size: 0.44,
    circle: { circleVisiblePart: 0.7, orthographic: false }
};

export const MIN_PLANE_COUNT = 30;

/** Responsive layout presets (`desktop` = default; xs/sm/md from debugger screenshots). */
export type BreakpointPresetKey = 'xs' | 'sm' | 'md' | 'desktop';

export const DEFAULT_BREAKPOINT: BreakpointPresetKey = 'desktop';

export const BREAKPOINT_PRESETS: Record<BreakpointPresetKey, LayoutPreset> = {
    xs: {
        gap: 0.52,
        size: 0.35,
        fisheye: { enabled: true, effect: -0.5, scale: 1.54 },
        circle: { circleVisiblePart: 0.7, orthographic: false }
    },
    sm: {
        gap: 0.56,
        size: 0.38,
        fisheye: { enabled: true, effect: -0.5, scale: 1.54 },
        circle: { circleVisiblePart: 0.7, orthographic: false }
    },
    md: {
        gap: 0.51,
        size: 0.38,
        fisheye: { enabled: true, effect: -0.5, scale: 1.54 },
        circle: { circleVisiblePart: 0.7, orthographic: false }
    },
    desktop: {
        gap: DEFAULT_PRESET.gap,
        size: DEFAULT_PRESET.size,
        fisheye: { ...DEFAULT_PRESET.fisheye },
        circle: { ...DEFAULT_PRESET.circle }
    }
};
