import type { BreakpointPresetKey } from '../OglVegaCarousel/OglVegaCarousel.ts';

export type { BreakpointPresetKey };

export type LayoutPreset = {
    gap: number;
    size: number;
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
export const DEFAULT_BREAKPOINT: BreakpointPresetKey = 'desktop';

export const BREAKPOINT_PRESETS: Record<BreakpointPresetKey, LayoutPreset> = {
    xs: {
        gap: 0.52,
        size: 0.35,
        circle: { circleVisiblePart: 0.7, orthographic: false }
    },
    sm: {
        gap: 0.56,
        size: 0.38,
        circle: { circleVisiblePart: 0.7, orthographic: false }
    },
    md: {
        gap: 0.51,
        size: 0.38,
        circle: { circleVisiblePart: 0.7, orthographic: false }
    },
    desktop: {
        gap: DEFAULT_PRESET.gap,
        size: DEFAULT_PRESET.size,
        circle: { ...DEFAULT_PRESET.circle }
    }
};
