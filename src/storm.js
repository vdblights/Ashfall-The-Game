import * as THREE from 'three';
import { WIND } from './ash.js';

/**
 * Storm waves.
 *
 * Some waves come in under weather (`stormFor`): rain driven across the
 * sector on a wind three times the usual, the haze thickened until the far
 * end of a street is gone, the sun dimmed behind a lid of cloud, and now and
 * then lightning. It cuts both ways, which is the point of it: a hostile
 * sees about half as far (`sight`, which `Enemy` reads where it reads its
 * `detect`), and so do you, and the marksmen on the roofs lose most of
 * their reach.
 *
 * The storm rises over the first seconds of its wave (`RAMP`) and clears
 * once the sector is, so it is weather that a wave arrives in, never a
 * switch. Everything it moves is a uniform or a light's intensity — the fog
 * density, the sun, the hemisphere, the clouds' cover, the wind the ash and
 * smoke ride, and the rain's own opacity — so it compiles nothing and a
 * paused game is a still one. The rain is placed in its vertex shader off
 * game time and a hash per streak, like the ash, and it is hidden under
 * anything standing over it by the same roof map, so it does not fall
 * through a shop's ceiling. Nothing here draws on `Math.random`, and the
 * streaks are built in the caller's `reserve`, so neither the layout nor
 * any spawn moves; lightning is timed off a hash of the wave and the strike.
 */

/** Which waves bring a storm: the fifth, and every fourth after it. */
export function stormFor(wave) {
  return wave >= 5 && (wave - 5) % 4 === 0;
}

/** Everything a storm at full strength does, as a factor on the clear day. */
export const STORM = {
  ramp: 8,            // seconds to rise to full, and to clear again
  fog: 3.2,           // haze density
  sun: 0.4,           // what is left of the sun
  hemi: 0.75,         // and of the sky light
  wind: 3.2,          // the wind the ash, the smoke and the rain ride
  sight: 0.5,         // how far a hostile sees
  flash: 2.6,         // lightning, on the hemisphere, as a share of its clear-day light
};

/** Streaks built; each tier draws the first so many. */
const RAIN_COUNT = 7000;
const RAIN_TIER = { high: 7000, medium: 4500, low: 2000 };
const BOX = 26, BOX_LOW = 5, BOX_HIGH = 15;
const FALL = 11;               // metres a second
const STREAK = 0.055;          // seconds of fall a streak is long

function hash(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const RAIN_VERT = /* glsl */`
  attribute vec4 seed;            // x, y, z in 0..1 through the box; w a phase
  attribute float tip;            // 0 the head of a streak, 1 its tail
  uniform float time;
  uniform vec2 wind;              // the wind now, which sets the slant
  uniform vec2 drift;             // how far the wind has carried the rain so far
  uniform float level;
  uniform sampler2D roofs;
  uniform float roofReach;
  varying float vAlpha;
  #include <fog_pars_vertex>

  void main() {
    float fall = ${FALL.toFixed(1)} * (0.85 + 0.3 * fract(seed.w * 7.13));
    const vec3 box = vec3(${BOX.toFixed(1)}, ${(BOX_LOW + BOX_HIGH).toFixed(1)}, ${BOX.toFixed(1)});
    vec3 origin = cameraPosition - vec3(${(BOX / 2).toFixed(1)}, ${BOX_LOW.toFixed(1)}, ${(BOX / 2).toFixed(1)});
    vec3 head = origin + mod(seed.xyz * box + vec3(drift.x, -fall * time, drift.y) - origin, box);
    // the streak trails back up the way it came
    vec3 vel = vec3(wind.x, -fall, wind.y);
    vec3 p = head - vel * ${STREAK.toFixed(3)} * tip;

    vec2 uv = (head.xz + roofReach) / (2.0 * roofReach);
    float roof = 0.0;
    if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0))))
      roof = texture2D(roofs, uv).r * ${(255 * 0.25).toFixed(2)};

    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float dist = -mvPosition.z;
    float edge = max(abs(head.x - cameraPosition.x), abs(head.z - cameraPosition.z)) / ${(BOX / 2).toFixed(1)};
    vAlpha = level * (1.0 - smoothstep(0.65, 1.0, edge)) * smoothstep(0.4, 1.4, dist);
    vAlpha *= 0.55 + 0.45 * fract(seed.w * 13.7);
    if (head.y < roof + 0.05 || level <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; }
    #include <fog_vertex>
  }
`;

const RAIN_FRAG = /* glsl */`
  uniform vec3 color;
  varying float vAlpha;
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(color, vAlpha * 0.32);
    #include <fog_fragment>
  }
`;

export class Storm {
  /**
   * @param scene  the world scene
   * @param roofs  the ash's roof map (`Ashfall.roofs`), which keeps rain out of rooms
   */
  constructor(scene, roofs) {
    const n = RAIN_COUNT;
    const seeds = new Float32Array(n * 2 * 4), tips = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) {
        const v = hash(i * 4 + k + 777);
        seeds[i * 8 + k] = v;
        seeds[i * 8 + 4 + k] = v;
      }
      tips[i * 2 + 1] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    geo.setAttribute('tip', new THREE.BufferAttribute(tips, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        time: { value: 0 }, wind: { value: WIND.clone() }, drift: { value: new THREE.Vector2() },
        level: { value: 0 }, roofs: { value: null }, roofReach: { value: 200 },
        color: { value: new THREE.Color(0.55, 0.57, 0.6) },
      }]),
      vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
      transparent: true, depthWrite: false, fog: true,
    });
    this.mat.uniforms.roofs.value = roofs;
    this.rain = new THREE.LineSegments(geo, this.mat);
    this.rain.name = 'rain';
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 2;
    this.rain.visible = false;
    scene.add(this.rain);

    this.level = 0;          // 0 clear .. 1 full storm
    this.target = 0;
    this.wave = 0;
    this.drift = new THREE.Vector2();
    this.flash = 0;
    this.nextStrike = Infinity;
    this.strikes = 0;
  }

  /** How many streaks this tier draws. */
  setTier(tier) {
    this.rain.geometry.setDrawRange(0, (RAIN_TIER[tier] ?? RAIN_TIER.high) * 2);
  }

  /** A wave begins: is it a storm? */
  begin(wave, time) {
    this.wave = wave;
    this.target = stormFor(wave) ? 1 : 0;
    this.strikes = 0;
    this.nextStrike = this.target ? time + 6 + hash(wave * 31) * 8 : Infinity;
    return this.target > 0;
  }

  /** The sector is clear, or the run is over: the weather goes. */
  clear() {
    this.target = 0;
    this.nextStrike = Infinity;
  }

  /** At once, for a new run or the menu. */
  reset() {
    this.level = this.target = this.flash = 0;
    this.nextStrike = Infinity;
    this.drift.set(0, 0);
  }

  /** How far a hostile sees, as a share of a clear day. */
  get sight() { return 1 - (1 - STORM.sight) * this.level; }

  /** The wind now, metres a second. */
  windNow(out = new THREE.Vector2()) {
    return out.copy(WIND).multiplyScalar(1 + (STORM.wind - 1) * this.level);
  }

  /**
   * Once a step, on game time. Returns a lightning strike when one fires
   * (`{ gain, delay }` for its thunder), else null.
   */
  update(dt, time) {
    const step = dt / STORM.ramp;
    this.level = this.target > this.level ? Math.min(this.target, this.level + step) : Math.max(this.target, this.level - step);
    // the wind past the usual, carried: ash and rain read it as an offset,
    // because the wind times the clock would throw every flake across the
    // box the moment the wind changed
    const extra = (STORM.wind - 1) * this.level * dt;
    this.drift.x += WIND.x * extra;
    this.drift.y += WIND.y * extra;
    this.flash = Math.max(0, this.flash - dt * 5);
    if (time >= this.nextStrike && this.level > 0.6) {
      this.strikes++;
      const k = this.wave * 101 + this.strikes;
      this.flash = 0.6 + 0.4 * hash(k);
      this.nextStrike = time + 9 + hash(k * 7 + 3) * 16;
      return { gain: 0.5 + 0.5 * hash(k * 13), delay: 0.6 + hash(k * 17) * 2.4 };
    }
    return null;
  }

  /** Every frame: put the weather into what the frame is drawn with. */
  apply(game) {
    const L = this.level;
    game.scene.fog.density = game.fogBase * (1 + (STORM.fog - 1) * L);
    game.sun.intensity = game.sunBase * (1 - (1 - STORM.sun) * L);
    // lightning comes and goes in a double flicker
    const f = this.flash > 0 ? this.flash * (0.6 + 0.4 * Math.abs(Math.sin(this.flash * 40))) : 0;
    game.hemi.intensity = game.hemiBase * (1 - (1 - STORM.hemi) * L + STORM.flash * f);
    game.sky.material.uniforms.storm.value = L;
    const wind = this.windNow(V2);
    const ash = game.ashfall;
    for (const m of [ash.ashMat, ash.smokeMat, ash.emberMat, this.mat]) m.uniforms.wind.value.copy(wind);
    ash.ashMat.uniforms.gust.value.copy(this.drift);
    this.mat.uniforms.drift.value.copy(this.drift);
    this.mat.uniforms.time.value = game.time;
    this.mat.uniforms.level.value = L;
    this.rain.visible = L > 0;
  }
}

const V2 = new THREE.Vector2();
