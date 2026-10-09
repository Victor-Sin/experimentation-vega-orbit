import type {
    BreakpointPresetKey,
    CarouselScrollPreset
} from '../OglVegaCarousel/OglVegaCarousel.ts';

export type { BreakpointPresetKey };

const DEFAULT_SCROLL: CarouselScrollPreset = {
    idleSpeed: 0.002,
    influence: 0.01,
    damping: 18,
    travel: 2
};

export type LayoutPreset = {
    gap: number;
    size: number;
    minPlaneCount: number;
    scroll: CarouselScrollPreset;
    circle: {
        /** Fraction of the canvas width filled by the ring's outer diameter. `0.7` = 70%. */
        circleVisiblePart: number;
        maxCircleVisiblePart: number;
        /** Fraction of the host height over which the visible part reaches its max. */
        visiblePartScroll: number;
        /** Ring Z at the end of that same scroll. Starts at 0. */
        translateZ: number;
        orthographic: boolean;
    };
};

export const MIN_PLANE_COUNT = 30;

export const DEFAULT_PRESET: LayoutPreset = {
    gap: 0.6,
    size: 0.44,
    minPlaneCount: MIN_PLANE_COUNT,
    scroll: { ...DEFAULT_SCROLL },
    circle: {
        circleVisiblePart: 0.7,
        maxCircleVisiblePart: 1.2,
        visiblePartScroll: 0.5,
        translateZ: -2.5,
        orthographic: false
    }
};

/** Responsive layout presets (`desktop` = default; xs/sm/md from debugger screenshots). */
export const DEFAULT_BREAKPOINT: BreakpointPresetKey = 'desktop';

export const BREAKPOINT_PRESETS: Record<BreakpointPresetKey, LayoutPreset> = {
    xs: {
        gap: 0.52,
        size: 0.65,
        minPlaneCount: 20,
        scroll: { ...DEFAULT_SCROLL },
        circle: {
            circleVisiblePart: 1.87,
            maxCircleVisiblePart: 3,
            visiblePartScroll: 0.5,
            translateZ: -2,
            orthographic: false
        }
    },
    sm: {
        gap: 0.56,
        size: 0.38,
        minPlaneCount: 20,
        scroll: { ...DEFAULT_SCROLL },
        circle: {
            circleVisiblePart: 1.3,
            maxCircleVisiblePart: 1.5,
            visiblePartScroll: 0.5,
            translateZ: -0.5,
            orthographic: false
        }
    },
    md: {
        gap: 0.51,
        size: 0.38,
        minPlaneCount: 20,
        scroll: { ...DEFAULT_SCROLL },
        circle: {
            circleVisiblePart: 0.55,
            maxCircleVisiblePart: 1.5,
            visiblePartScroll: 0.5,
            translateZ: -1.2,
            orthographic: false
        }
    },
    desktop: {
        gap: DEFAULT_PRESET.gap,
        size: DEFAULT_PRESET.size,
        minPlaneCount: DEFAULT_PRESET.minPlaneCount,
        scroll: { ...DEFAULT_PRESET.scroll },
        circle: { ...DEFAULT_PRESET.circle }
    }
};
