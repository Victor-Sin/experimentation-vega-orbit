/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare namespace astroHTML.JSX {
    interface IntrinsicElements {
        'c-webgpu-canvas': astroHTML.JSX.HTMLAttributes;
    }
}
