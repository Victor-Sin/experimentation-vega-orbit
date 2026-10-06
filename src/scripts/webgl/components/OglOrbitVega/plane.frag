precision highp float;

uniform sampler2D uMap;
uniform float uTextureFade;

varying vec2 vUv;

void main() {
    vec4 mapColor = texture2D(uMap, vUv);
    float circle = 1.0 - step(0.75, distance(vUv, vec2(0.5)) + 0.25);
    vec4 placeholder = vec4(0.588, 0.588, 0.588, circle);
    vec4 imageColor = vec4(mapColor.rgb, mapColor.a * circle);
    gl_FragColor = mix(placeholder, imageColor, uTextureFade);
}
