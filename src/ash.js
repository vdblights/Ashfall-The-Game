import * as THREE from 'three';
import { SUN_DIR, SUN_COLOR } from './atmosphere.js';

/**
 * Ash falling, and the smoke it falls from.
 *
 * The game is called ASHFALL and the air over it was clean: a gold
 * afternoon, a few hundred motes of dust standing still, and nothing in the
 * sky that said the city was still burning. Two things here say it.
 *
 * - **Ash** drifts down round the camera: a few thousand flakes, each a
 *   point that tumbles as it falls, blown along by the wind and swaying in
 *   it. Every flake moves in the vertex shader off game time and its own
 *   seed, inside a box that wraps round the camera, so the CPU does nothing
 *   a frame but set two uniforms, and a paused game is a still one. A flake
 *   is not drawn where something stands over it — a roof, a shop's ceiling,
 *   a block past the wall — which it asks of a height map of the tallest
 *   thing in each square metre of the sector, baked once at boot from the
 *   box list. Without it, ash fell through every ceiling into every shop.
 * - **Smoke** stands over the city in four columns past the wall, each a
 *   stack of soft billboards rising off a fire at its foot, spreading and
 *   bending downwind as it climbs, the same wind the ash rides. They are far
 *   enough off that the height fog takes their feet, which is what makes
 *   them read as distant and enormous rather than near and small.
 *
 * Both are decoration by every rule this repo has for it: in neither
 * collision list, no raycast target, no shadow, built inside the caller's
 * `reserve`, and drawing nothing from `Math.random` — every flake and puff
 * comes off a hash. They wear `ShaderMaterial`s with the scene's own fog
 * chunks, so they fade into exactly the haze everything else does.
 */

/** Which way the air is going, in metres a second. One wind for ash and smoke. */
export const WIND = new THREE.Vector2(0.85, 0.3);

/** Flakes built; each tier draws the first so many (`setTier`). */
export const ASH_COUNT = 5000;
/** Flakes drawn on each tier. Low keeps some, because it is the game's name. */
const ASH_TIER = { high: 5000, medium: 3500, low: 1500 };

/** The box of air round the camera that the flakes wrap in, in metres. */
const BOX = 28;
const BOX_LOW = 6;      // how far under the eye the box reaches
const BOX_HIGH = 16;    // and how far over it

/** Height map: one texel a metre, in quarter metres, out this far from the middle. */
const MAP_REACH = 200;
const MAP_STEP = 0.25;

function hash(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const v3 = (v) => `vec3(${v.x.toFixed(6)}, ${v.y.toFixed(6)}, ${v.z.toFixed(6)})`;

/* --------------------------------------------------------------------- ash */

const ASH_VERT = /* glsl */`
  attribute vec4 seed;            // x, y, z in 0..1 through the box; w a phase
  uniform float time;
  uniform float scale;            // pixels per metre at one metre
  uniform vec2 wind;
  uniform sampler2D roofs;
  uniform float roofReach;
  varying float vAlpha;
  varying float vSpin;
  varying float vTumble;
  varying float vShade;
  #include <fog_pars_vertex>

  void main() {
    float ph = seed.w * 6.2831;
    // ash is light: it falls at well under a metre a second and the wind
    // carries it further sideways than down
    float fall = 0.35 + 0.4 * fract(seed.w * 7.13);
    vec3 drift = vec3(wind.x, -fall, wind.y) * time;
    drift.x += sin(time * 0.7 + ph) * 0.45;
    drift.z += cos(time * 0.53 + ph * 1.7) * 0.45;
    drift.y += sin(time * 1.1 + ph * 2.3) * 0.12;

    // wrap into a box that follows the camera
    const vec3 box = vec3(${BOX.toFixed(1)}, ${(BOX_LOW + BOX_HIGH).toFixed(1)}, ${BOX.toFixed(1)});
    vec3 origin = cameraPosition - vec3(${(BOX / 2).toFixed(1)}, ${BOX_LOW.toFixed(1)}, ${(BOX / 2).toFixed(1)});
    vec3 p = origin + mod(seed.xyz * box + drift - origin, box);

    // under a roof, a ceiling or a block past the wall there is no ash
    vec2 uv = (p.xz + roofReach) / (2.0 * roofReach);
    float roof = 0.0;
    if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0))))
      roof = texture2D(roofs, uv).r * ${(255 * MAP_STEP).toFixed(2)};

    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float dist = -mvPosition.z;

    float size = 0.035 + 0.045 * fract(seed.w * 13.7);
    float px = size * scale / max(dist, 0.05);
    // under a pixel and a half a flake is a sparkle: grow it to that and
    // pay for the growth in opacity, so a distant flake is faint, not gone
    vAlpha = clamp(px / 1.5, 0.0, 1.0);
    gl_PointSize = max(px, 1.5);

    // fade in from the box's walls so a flake never pops in, and out right
    // at the lens, where one would be a blot
    float edge = max(abs(p.x - cameraPosition.x), abs(p.z - cameraPosition.z)) / ${(BOX / 2).toFixed(1)};
    vAlpha *= 1.0 - smoothstep(0.7, 1.0, edge);
    vAlpha *= smoothstep(0.3, 0.9, dist);
    if (p.y < roof + 0.05 || dist < 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; }

    vSpin = time * (0.8 + 1.6 * fract(seed.w * 3.1)) + ph;
    vTumble = time * (1.2 + 2.0 * fract(seed.w * 5.9)) + ph * 0.5;
    vShade = fract(seed.w * 17.3);
    #include <fog_vertex>
  }
`;

const ASH_FRAG = /* glsl */`
  uniform vec3 lit;
  uniform vec3 shade;
  varying float vAlpha;
  varying float vSpin;
  varying float vTumble;
  varying float vShade;
  #include <fog_pars_fragment>

  void main() {
    // a flake tumbling is a flat scrap seen face on and then edge on: turn
    // the sprite, squash it across by how far round it has tumbled, and
    // break its outline so it is a scrap and not a disc
    vec2 q = gl_PointCoord - 0.5;
    float c = cos(vSpin), s = sin(vSpin);
    q = mat2(c, -s, s, c) * q;
    float face = abs(cos(vTumble));
    q.x /= 0.25 + 0.75 * face;
    float a = atan(q.y, q.x);
    float r = 0.42 + 0.06 * sin(a * 3.0 + vSpin * 1.7) + 0.04 * sin(a * 5.0 - vShade * 9.0);
    float d = length(q);
    float alpha = (1.0 - smoothstep(r - 0.12, r, d)) * vAlpha;
    if (alpha < 0.02) discard;

    // a face turned to the sun catches it; the rest is the grey of the air
    vec3 col = mix(shade, lit, face * (0.55 + 0.45 * vShade));
    gl_FragColor = vec4(col, alpha * 0.9);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/**
 * The tallest thing over each square metre of ground, in quarter metres:
 * every box in the city that stands over a body, and the blocks past the
 * wall. A flake below it is hidden.
 */
function roofMap(world, outskirts) {
  const N = MAP_REACH * 2;
  const data = new Uint8Array(N * N);
  const put = (minX, minZ, maxX, maxZ, top) => {
    const v = Math.min(255, Math.ceil(top / MAP_STEP));
    const i0 = Math.max(0, Math.floor(minX + MAP_REACH)), i1 = Math.min(N - 1, Math.floor(maxX + MAP_REACH));
    const j0 = Math.max(0, Math.floor(minZ + MAP_REACH)), j1 = Math.min(N - 1, Math.floor(maxZ + MAP_REACH));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) if (v > data[j * N + i]) data[j * N + i] = v;
    }
  };
  for (const b of world.boxes) {
    // a kerb, a floor or a heap: ash lies on them, it is not kept off them.
    // A narrow thing — a post, a lamp — covers too little to hide a flake
    // beside it and would cut a square metre out of the air round it.
    if (b.top < 1.2 || b.floor || b.heap) continue;
    if (Math.min(b.maxX - b.minX, b.maxZ - b.minZ) < 0.6) continue;
    put(b.minX, b.minZ, b.maxX, b.maxZ, b.top);
  }
  for (const [px, pz, hx, hz, top] of outskirts?.userData.blocks || []) {
    put(px - hx, pz - hz, px + hx, pz + hz, top);
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------- smoke */

/** Puffs to a column, and the columns. */
const PUFFS = 72;

const SMOKE_VERT = /* glsl */`
  attribute vec3 base;            // the fire at the column's foot
  attribute vec4 plume;           // height, width, seed, rise speed (m/s)
  attribute float puff;           // 0..1 down the column
  uniform float time;
  uniform vec2 wind;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;
  varying vec3 vWorld;
  #include <fog_pars_vertex>

  void main() {
    float H = plume.x, W = plume.y;
    // each puff climbs the column and starts again at the fire; the age
    // runs from 0 at the foot to 1 where it has spread into the haze
    float age = fract(puff + time * plume.w / H);
    float k = pow(age, 1.35);
    float seed = fract(puff * 37.1 + plume.z);
    vec3 c = base;
    c.y += age * H;
    // the column bends downwind as it climbs, and wanders a little
    c.xz += wind * k * H * 0.7;
    c.x += sin(puff * 23.0 + time * 0.07 + plume.z * 9.0) * W * (0.2 + 0.8 * age);
    c.z += cos(puff * 17.0 + time * 0.05 + plume.z * 5.0) * W * (0.2 + 0.8 * age);
    float size = W * (0.7 + 4.5 * k) * (0.8 + 0.4 * seed);

    // a billboard: the camera's own right and up out of the view matrix
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float t = seed * 6.2831 + time * 0.02 * (seed - 0.5);
    vec2 corner = mat2(cos(t), -sin(t), sin(t), cos(t)) * position.xy;
    vec3 p = c + (right * corner.x + up * corner.y) * size;

    vUv = position.xy;
    vAge = age;
    vSeed = seed + plume.z;
    vWorld = p;
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const SMOKE_FRAG = /* glsl */`
  uniform vec3 sunColor;
  uniform vec3 shadeColor;
  uniform float time;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;
  varying vec3 vWorld;
  #include <fog_pars_fragment>

  float h21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x),
               mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  void main() {
    vec2 q = vUv * 2.0;                       // -1..1 across the puff
    float r = length(q);
    if (r > 1.0) discard;
    vec2 o = vec2(vSeed * 31.0, vSeed * 17.0 - time * 0.03);
    float n = 0.55 * vnoise(q * 2.2 + o) + 0.3 * vnoise(q * 4.7 - o) + 0.15 * vnoise(q * 9.0 + o * 1.3);
    float body = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.9);
    // thick and dark off the fire, thinning to a veil as it spreads
    float alpha = body * smoothstep(0.0, 0.06, vAge) * (1.0 - smoothstep(0.45, 1.0, vAge));
    alpha *= mix(0.95, 0.45, vAge);
    if (alpha < 0.01) discard;

    // a puff is lit like a ball of wool: the side toward the sun takes its
    // colour and the rest the grey of the smoke itself
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 toward = normalize(cameraPosition - vWorld);
    vec3 nrm = normalize(right * q.x + up * q.y + toward * sqrt(max(0.0, 1.0 - r * r)));
    float sun = clamp(dot(nrm, ${v3(SUN_DIR)}) * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = shadeColor * mix(0.55, 1.4, vAge) + sunColor * sun * sun * mix(0.15, 0.6, vAge) * (0.6 + 0.4 * n);
    // the fire under it lights the foot of the column from below
    col += vec3(1.0, 0.36, 0.08) * (1.0 - smoothstep(0.0, 0.07, vAge)) * 3.0 * body;

    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/**
 * Where the columns stand: four bearings round the sector, a quarter turn
 * apart and jittered, at distances from just past the wall's landscape to
 * the hills, so from anywhere in the sector at least one is in front of you.
 */
function plumeSites(seed, edge, heightAt) {
  const out = [];
  const a0 = hash(seed * 7 + 1) * Math.PI * 2;
  const reach = [edge + 70, edge + 140, edge + 230, edge + 310];
  for (let k = 0; k < 4; k++) {
    const a = a0 + k * Math.PI / 2 + (hash(seed * 7 + 2 + k) - 0.5) * 0.9;
    const d = reach[(k + Math.floor(hash(seed * 11 + k) * 4)) % 4];
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    out.push({
      x, z, y: heightAt(x, z),
      height: 170 + 90 * hash(seed * 13 + k),
      width: 16 + 10 * hash(seed * 17 + k),
      seed: hash(seed * 19 + k),
      rise: 4.5 + 2.0 * hash(seed * 23 + k),
    });
  }
  return out;
}

/* -------------------------------------------------------------------- both */

export class Ashfall {
  /**
   * @param scene    the world scene
   * @param world    the box list the roofs are read from
   * @param outskirts the landscape past the wall (`city.outer`)
   * @param opts     `{ seed, edge, heightAt }`
   */
  constructor(scene, world, outskirts, { seed = 1, edge = 136, heightAt = () => 0 } = {}) {
    const fog = THREE.UniformsLib.fog;

    // ash
    const seeds = new Float32Array(ASH_COUNT * 4);
    for (let i = 0; i < ASH_COUNT * 4; i++) seeds[i] = hash(i * 2654435761 + 12345);
    const geo = new THREE.BufferGeometry();
    // the position is never read — the shader places every flake — but
    // three sizes the draw off it
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ASH_COUNT * 3), 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    this.roofs = roofMap(world, outskirts);
    this.ashMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([fog, {
        time: { value: 0 }, scale: { value: 600 }, wind: { value: WIND.clone() },
        roofs: { value: null }, roofReach: { value: MAP_REACH },
        lit: { value: new THREE.Color(0.05, 0.047, 0.044) },
        shade: { value: new THREE.Color(0.014, 0.0135, 0.013) },
      }]),
      vertexShader: ASH_VERT, fragmentShader: ASH_FRAG,
      transparent: true, depthWrite: false, fog: true,
    });
    // a texture through `merge` would be cloned; hand it over as itself
    this.ashMat.uniforms.roofs.value = this.roofs;
    this.ash = new THREE.Points(geo, this.ashMat);
    this.ash.name = 'ash';
    this.ash.frustumCulled = false;
    this.ash.renderOrder = 2;
    scene.add(this.ash);

    // smoke
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.sites = plumeSites(seed, edge, heightAt);
    const n = this.sites.length * PUFFS;
    const base = new Float32Array(n * 3), plume = new Float32Array(n * 4), puff = new Float32Array(n);
    // the puffs drawn back to front within a column would need sorting each
    // frame; drawn top first, the column's dense foot lies over its veil,
    // which is the side it is seen from nearly always
    let i = 0;
    for (const s of this.sites) {
      for (let k = 0; k < PUFFS; k++, i++) {
        base.set([s.x, s.y, s.z], i * 3);
        plume.set([s.height, s.width, s.seed, s.rise], i * 4);
        puff[i] = 1 - (k + hash(i * 31 + 7) * 0.6) / PUFFS;
      }
    }
    quad.setAttribute('base', new THREE.InstancedBufferAttribute(base, 3));
    quad.setAttribute('plume', new THREE.InstancedBufferAttribute(plume, 4));
    quad.setAttribute('puff', new THREE.InstancedBufferAttribute(puff, 1));
    quad.instanceCount = n;
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([fog, {
        time: { value: 0 }, wind: { value: WIND.clone() },
        sunColor: { value: SUN_COLOR.clone() },
        shadeColor: { value: new THREE.Color(0.035, 0.032, 0.03) },
      }]),
      vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
      transparent: true, depthWrite: false, fog: true,
    });
    this.smoke = new THREE.Mesh(quad, this.smokeMat);
    this.smoke.name = 'smoke';
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 1;
    scene.add(this.smoke);
  }

  /** How many flakes this tier draws. */
  setTier(tier) {
    this.ash.geometry.setDrawRange(0, ASH_TIER[tier] ?? ASH_TIER.high);
  }

  /**
   * Once a frame: game time, so a paused game is still, and how many pixels
   * a metre is at a metre's distance, so a flake is the size it should be
   * at any resolution or field of view.
   */
  update(time, camera, pixelHeight) {
    this.ashMat.uniforms.time.value = time;
    this.smokeMat.uniforms.time.value = time;
    const f = 1 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    this.ashMat.uniforms.scale.value = pixelHeight * 0.5 * f;
  }
}
