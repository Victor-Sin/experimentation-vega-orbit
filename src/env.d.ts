/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare namespace astroHTML.JSX {
    interface IntrinsicElements {
        'c-loco-canvas': astroHTML.JSX.HTMLAttributes;
        'c-wheel-vega': astroHTML.JSX.HTMLAttributes;
    }
}
