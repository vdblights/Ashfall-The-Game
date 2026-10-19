import * as THREE from 'three';

/*
 * Wet ground: the street after rain that never quite dried, and the fire in it.
 *
 * Two things, both in the fragment shader of the materials that ask for them
 * and nowhere else, so they cost no geometry, no texture and nothing from the
 * seeded stream.
 *
 * The asphalt is wet where water would lie: along both gutters, where the
 * camber sends it, and in patches across the carriageway off a world-space
 * field, so it runs across the 8 m tile instead of repeating with it. Wet
 * asphalt is darker, nearly smooth, and its texture is drowned, so what it
 * shows is the sky through the environment map, the same mirror a puddle
 * is, blurred. The sun's own highlight on it is turned down, for the reason
 * the puddles give: at that smoothness a correct one blooms into a white egg.
 *
 * And it reflects the fires. A real reflection would be a second render of
 * the city a frame; this is a mirror worked out per pixel against the few
 * flames near the camera (`WET_FIRES`, written by `updateWet` once a frame).
 * The reflected view ray leaves the ground, and where it passes through a
 * flame's column the ground glows in the flame's colour, stretched along the
 * ray the further it has to go, which is the long vertical smear a fire
 * makes on a wet road. Nothing occludes it, so it only reaches 26 m from the
 * flame, and a flame is only handed in within 70 m of the camera.
 *
 * A puddle (`pool`) is the same mirror sharpened: all of it wet, the flame's
 * smear barely spread. The damp ring round it (`ring`) is half wet.
 */

/** Flames handed to the shader: xyz the foot of the flame, w its strength. */
export const WET_MAX = 4;
export const WET_FIRES = { value: Array.from({ length: WET_MAX }, () => new THREE.Vector4()) };
const WET_REACH = 70;
const FIRE_COLOR = '1.0, 0.43, 0.13';

const PARS = /* glsl */`
  uniform vec4 wetFires[${WET_MAX}];
  float wetHash(vec2 p) {
    p = fract(p * vec2(127.13, 311.71));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }
  float wetNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wetHash(i), wetHash(i + vec2(1.0, 0.0)), u.x),
               mix(wetHash(i + vec2(0.0, 1.0)), wetHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // A level mirror at P: the flames along the reflected view ray. \`spread\`
  // is how rough the water is, which is how far the smear stretches.
  vec3 wetFireGlow(vec3 P, float spread) {
    vec3 V = normalize(P - cameraPosition);
    vec3 R = vec3(V.x, -V.y, V.z);
    vec2 rh = R.xz;
    float rl = max(length(rh), 1e-3);
    vec3 sum = vec3(0.0);
    for (int i = 0; i < ${WET_MAX}; i++) {
      vec4 f = wetFires[i];
      if (f.w <= 0.0) continue;
      vec2 toF = f.xz - P.xz;
      float d = dot(toF, rh) / rl;            // along the ray, level distance
      if (d <= 0.0) continue;
      vec2 miss = toF - rh / rl * d;
      float h = P.y + R.y / rl * d - f.y;      // height over the flame's foot
      float w = 0.2 + d * spread * 0.35;
      float lat = exp(-dot(miss, miss) / (w * w));
      float stretch = d * spread * 2.2;
      float vert = smoothstep(-0.15 - stretch * 0.25, 0.35, h)
        * (1.0 - smoothstep(1.05, 1.25 + stretch, h));
      float fade = 1.0 - smoothstep(14.0, 26.0, d);
      sum += vec3(${FIRE_COLOR}) * f.w * lat * vert * fade;
    }
    // water reflects more the more steeply it is looked across
    float fres = mix(0.35, 1.0, pow(1.0 - clamp(-V.y, 0.0, 1.0), 3.0));
    return sum * fres;
  }
`;

// how wet this pixel is: the field for the street, a constant for water
const AMOUNT = {
  street: /* glsl */`
    {
      vec3 wetUp = normalize(viewMatrix[1].xyz);
      float wetFacing = smoothstep(0.85, 0.97, dot(normal, wetUp));
      vec2 p = vFogWorld.xz;
      // distance off each street's centre line; the gutter is at the kerb
      vec2 off = abs(p - BLOCK * floor(p / BLOCK + 0.5));
      float gutter = 0.0;
      if (off.x < ROAD_HALF) gutter = max(gutter, smoothstep(ROAD_HALF - 1.6, ROAD_HALF - 0.1, off.x));
      if (off.y < ROAD_HALF) gutter = max(gutter, smoothstep(ROAD_HALF - 1.6, ROAD_HALF - 0.1, off.y));
      float field = wetNoise(p * 0.11) * 0.55 + wetNoise(p * 0.43 + 7.0) * 0.3 + wetNoise(p * 1.9 - 3.0) * 0.15;
      float pools = smoothstep(0.5, 0.64, field);
      float runs = gutter * smoothstep(0.3, 0.55, field + 0.12);
      wetAmt = wetFacing * clamp(max(pools, runs), 0.0, 1.0)
        * (1.0 - smoothstep(0.6, 1.2, vFogWorld.y));
    }
  `,
  pool: 'wetAmt = 1.0;',
  ring: 'wetAmt = 0.55;',
};

const SPREAD = { street: 0.09, pool: 0.012, ring: 0.05 };

/**
 * Make a material wet. `kind` is `street` (the field), `pool` or `ring`;
 * `env` is how much the wet part reflects the sky against the dry, and
 * `sun` what is left of the sun's highlight on it. Chains any
 * `onBeforeCompile` already set, and is called at boot, before anything is
 * compiled, because the program it makes is a different program.
 */
export function wetten(mat, kind, { env = 1, sun = 1, block = 34, roadHalf = 3 } = {}) {
  const before = mat.onBeforeCompile;
  const beforeKey = mat.customProgramCacheKey;
  const amount = AMOUNT[kind].replaceAll('BLOCK', block.toFixed(3)).replaceAll('ROAD_HALF', roadHalf.toFixed(3));
  const surface = kind === 'street' ? /* glsl */`
      diffuseColor.rgb *= mix(1.0, 0.5, wetAmt);
      #ifdef STANDARD
        roughnessFactor = mix(roughnessFactor, 0.18, wetAmt);
      #endif
      normal = normalize(mix(normal, normalize(viewMatrix[1].xyz), wetAmt * 0.85));
  ` : '';
  mat.onBeforeCompile = (shader, renderer) => {
    before?.call(mat, shader, renderer);
    shader.uniforms.wetFires = WET_FIRES;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float wetAmt = 0.0;
        #ifdef USE_FOG
          ${amount}
        #endif
        ${surface}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #ifdef USE_FOG
          reflectedLight.indirectSpecular *= mix(1.0, ${env.toFixed(3)}, wetAmt);
          reflectedLight.directSpecular *= mix(1.0, ${sun.toFixed(3)}, wetAmt);
          reflectedLight.indirectSpecular += wetFireGlow(vFogWorld, ${SPREAD[kind].toFixed(3)}) * wetAmt;
        #endif`);
  };
  const key = ['wet', kind, env, sun].join('-') + (before ? before.toString() : '');
  mat.customProgramCacheKey = () => key;
  mat.userData.wet = kind;
  // what it was before, so a check can dry it and compare
  mat.userData.dry = { onBeforeCompile: before, customProgramCacheKey: beforeKey };
  return mat;
}

const WET_P = new THREE.Vector3();
const WET_PICK = [];

/**
 * Hand the shader the flames nearest the camera, each at the foot of its
 * flame and as bright as its light this frame; a blown drum hands in
 * nothing. Vectors only, nothing minted, nothing from the seeded stream.
 */
export function updateWet(barrels, height, camera) {
  const out = WET_FIRES.value;
  WET_PICK.length = 0;
  for (const b of barrels || []) {
    if (b.burst) continue;
    const d = Math.hypot(b.x - camera.position.x, b.z - camera.position.z);
    if (d < WET_REACH) WET_PICK.push([d, b]);
  }
  WET_PICK.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < WET_MAX; i++) {
    const pick = WET_PICK[i];
    if (!pick) { out[i].set(0, 0, 0, 0); continue; }
    const b = pick[1];
    const flicker = b.base ? b.light.intensity / b.base : 1;
    WET_P.set(b.x, b.y + height, b.z);
    out[i].set(WET_P.x, WET_P.y, WET_P.z, 2.4 * flicker * (1 - pick[0] / WET_REACH));
  }
}
