import * as THREE from 'three';

/**
 * Night waves.
 *
 * Some waves come after dark (`nightFor`): the sun goes down behind the ash,
 * the sky goes to a dull slate, the haze darkens with it, and what is left
 * to see by is the fire barrels, the hostiles' own lenses and lasers, and
 * the light on your gun. That light is the whole of the wave: `L` (or a
 * click of the right stick) puts a beam down the barrel that lights the
 * street in front of you, and it lights you up for everything on it. A
 * hostile in the dark sees a third as far as it does by day (`NIGHT.sight`,
 * which `Game.step` folds into `game.sight`, which `Enemy` reads where it
 * reads its `detect`), unless your light is on or your muzzle has flashed in
 * the last second and a half — then it sees you as well as it ever does.
 *
 * Night falls over the first seconds of its wave (`ramp`) and lifts once the
 * sector is clear, like a storm (storm.js), and it is built the same way:
 * everything it moves is a light's intensity, a uniform or the fog's colour,
 * each set every frame from a base the owner keeps (`sunBase`, `hemiBase`),
 * so it compiles nothing and a paused game is a still one. The fog chunk
 * (atmosphere.js) multiplies the haze's colour by `fog.color`, which three
 * hands to every material that takes fog, so the haze, the rain and the ash
 * darken together. The weapon light is a spot that is always in the scene
 * and always visible, at nothing while it is off, because the count of lit
 * spots is part of every lit program's key: one that came and went would
 * recompile the city every time it was switched. Nothing here draws on
 * `Math.random`, and the light is built in the caller's `reserve`.
 */

/** Which waves come after dark: the third, and every fourth after it. */
export function nightFor(wave) {
  return wave >= 3 && (wave - 3) % 4 === 0;
}

/** Everything a full night does, as a factor on the day. */
export const NIGHT = {
  ramp: 8,            // seconds for night to fall, and to lift
  sun: 0.03,          // what is left of the sun: a moon through the ash
  hemi: 0.16,         // and of the sky light
  env: 0.1,           // and of the sky's reflection on everything
  fill: 0.15,         // the cool fill and the bounce off the street
  smoke: 0.05,       // the sunlit side of the smoke columns
  view: 0.3,          // the gun in your hands, dark
  viewLit: 0.7,       // and with the light on it
  fog: new THREE.Color(0.075, 0.085, 0.12),   // the haze, lit by nothing much
  sight: 0.33,        // how far a hostile sees you in the dark
  flash: 1.5,         // seconds a muzzle flash gives you away for
  // the weapon light
  intensity: 170, distance: 55, angle: 0.4, penumbra: 0.55, decay: 1.6,
};

export class Night {
  /** @param scene the world scene, where the weapon light hangs */
  constructor(scene) {
    const s = new THREE.SpotLight(0xe8eeff, 0, NIGHT.distance, NIGHT.angle, NIGHT.penumbra, NIGHT.decay);
    s.name = 'weaponLight';
    s.castShadow = false;
    scene.add(s);
    scene.add(s.target);
    this.spot = s;
    this.level = 0;         // 0 day .. 1 full night
    this.target = 0;
    this.lightOn = false;
    this.lastShot = -Infinity;
  }

  /** A wave begins: is it after dark? */
  begin(wave) {
    this.target = nightFor(wave) ? 1 : 0;
    return this.target > 0;
  }

  /** The sector is clear, or the run is over: dawn. */
  clear() { this.target = 0; }

  /** At once, for a new run or the menu. */
  reset() {
    this.level = this.target = 0;
    this.lightOn = false;
    this.lastShot = -Infinity;
  }

  /** `L`: the weapon light on or off. Returns whether it is now on. */
  toggle() { return (this.lightOn = !this.lightOn); }

  /** The player fired: the flash is seen. */
  fired(time) { this.lastShot = time; }

  /** Is the player lit up for anything that is looking? */
  shown(time) {
    return this.lightOn || time - this.lastShot < NIGHT.flash;
  }

  /** How far a hostile sees, as a share of a day. */
  sight(time) {
    if (this.shown(time)) return 1;
    return 1 - (1 - NIGHT.sight) * this.level;
  }

  /** Once a step, on game time. */
  update(dt) {
    const step = dt / NIGHT.ramp;
    this.level = this.target > this.level ? Math.min(this.target, this.level + step) : Math.max(this.target, this.level - step);
  }

  /**
   * Every frame, after the storm has set its own: put the dark into what the
   * frame is drawn with, and the light where the gun points.
   */
  apply(game) {
    const L = this.level, mix = (day, night) => day + (night - day) * L;
    game.sun.intensity *= mix(1, NIGHT.sun);
    game.hemi.intensity *= mix(1, NIGHT.hemi);
    game.scene.environmentIntensity = mix(1, NIGHT.env);
    for (const l of game.dayLights || []) l.light.intensity = l.base * mix(1, NIGHT.fill);
    const lit = this.lightOn && !game.player.dead;
    const view = mix(1, lit ? NIGHT.viewLit : NIGHT.view);
    for (const l of game.viewLights || []) l.light.intensity = l.base * view;
    game.scene.fog.color.setRGB(mix(1, NIGHT.fog.r), mix(1, NIGHT.fog.g), mix(1, NIGHT.fog.b));
    game.sky.material.uniforms.night.value = L;
    // the smoke columns over the city were lit by the sun, and now are not
    const smoke = game.ashfall?.smokeMat?.uniforms.sunColor;
    if (smoke) {
      this.smokeSun ??= smoke.value.clone();
      smoke.value.copy(this.smokeSun).multiplyScalar(mix(1, NIGHT.smoke));
    }

    // the beam leaves from beside the barrel, a hand's width under the eye
    const cam = game.camera, s = this.spot;
    cam.getWorldDirection(FWD);
    RIGHT.crossVectors(FWD, cam.up).normalize();
    s.position.copy(cam.position).addScaledVector(RIGHT, 0.14).addScaledVector(cam.up, -0.12);
    s.target.position.copy(cam.position).addScaledVector(FWD, 20);
    s.updateMatrixWorld();
    s.target.updateMatrixWorld();
    s.intensity = lit ? NIGHT.intensity : 0;
  }
}

const FWD = new THREE.Vector3(), RIGHT = new THREE.Vector3();
