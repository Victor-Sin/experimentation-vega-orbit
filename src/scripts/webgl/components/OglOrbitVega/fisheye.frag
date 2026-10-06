precision highp float;

#define PI 3.1415926535

uniform sampler2D tMap;
uniform float uFisheyeEnabled;
uniform float uFisheyeEffect;
uniform float uFisheyeScale;

varying vec2 vUv;

// Three.js NeutralToneMapping, exposure 1 (WebGPU renderer default).
vec3 NeutralToneMapping(vec3 color) {
    const float StartCompression = 0.8 - 0.04;
    const float Desaturation = 0.15;

    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;

    float peak = max(color.r, max(color.g, color.b));
    if (peak < StartCompression) return color;

    float d = 1.0 - StartCompression;
    float newPeak = 1.0 - d * d / (peak + d - StartCompression);
    color *= newPeak / peak;

    float g = 1.0 - 1.0 / (Desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
}

void main() {
    float x = vUv.x * 2.0 - 1.0;
    float d = abs(x);
    float z = sqrt(max(1.0 + d * d * uFisheyeEffect, 0.00001));
    float r = atan(d, z) / PI * uFisheyeScale;
    vec2 distorted = vec2(r * sign(x) + 0.5, vUv.y);
    vec2 sampleUv = uFisheyeEnabled == 1.0 ? distorted : vUv;

    vec4 color = texture2D(tMap, sampleUv);
    color.rgb = NeutralToneMapping(color.rgb);
    gl_FragColor = sRGBTransferOETF(color);
}
