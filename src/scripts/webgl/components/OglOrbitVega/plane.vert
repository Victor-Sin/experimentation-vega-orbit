precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform float uBendRadius;
uniform float uBendByDistance;
uniform float uDistanceFactor;
uniform float uBendEnabled;
uniform float uDistance;

varying vec2 vUv;

void main() {
    vUv = uv;

    float amount = (uBendByDistance == 1.0 ? uDistance : 1.0) * uDistanceFactor * uBendEnabled;
    float x = uv.x - 0.5;
    float theta = x / uBendRadius;
    float bendZ = (1.0 - cos(theta)) * uBendRadius * amount;
    vec3 localPos = vec3(x, position.y, bendZ);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(localPos, 1.0);
}
