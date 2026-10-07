precision highp float;

uniform sampler2D uMap;
uniform float uTextureFade;

varying vec2 vUv;

void main() {
    vec4 mapColor = texture2D(uMap, vUv);
    float circle = 1.0 - step(0.75, distance(vUv, vec2(0.5)) + 0.25);
    vec3 placeholder = vec3(0.588);
    vec3 rgb = mix(placeholder, mapColor.rgb, uTextureFade);
    float alpha =  mapColor.a;
    gl_FragColor = vec4(rgb, alpha);
}
