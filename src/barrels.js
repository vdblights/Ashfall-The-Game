/**
 * Fire barrels go up.
 *
 * Every lit drum in the sector was scenery: a light, a flame and a collider
 * a round passed straight through, because the drum was never a raycast
 * target. Now a drum takes rounds (`hit`), and once it has taken enough it
 * flares and hisses for a moment and blows (`burst`) — through the same
 * `Game.explode` a frag does, so it hurts whoever is in reach, the player
 * included, and credits the player with whatever it kills when the player
 * set it off. A blast that reaches another lit drum sets that one off too,
 * a beat later for every metre between them (`blast`), so a street with
 * three barrels down it is a fuse.
 *
 * What is left is a stump: the drum crushed to a quarter of its height and
 * burnt black, its collider cut down to a step you walk over, its fire out
 * and its light dark, smouldering for half a minute. Nothing here draws on
 * the seeded stream or mints a three object — the drum is the mesh the city
 * built, left out of the bake so it can be shown burst (`unbaked` in
 * `bakeStatic`) — and the light it held stays in the pool at nothing, so
 * the count of point lights every lit program is compiled for never moves.
 */
import * as THREE from 'three';
import { audio } from './audio.js';

export const BARREL = {
  hp: 40,           // a rifle round and a half, two pistol rounds, a shotgun blast
  fuse: 0.45,       // from the last round to the blast: long enough to see it coming
  chain: 0.18,      // a drum set off by a blast waits this long…
  perM: 0.04,       // …and this much more for every metre from it
  reach: 1.25,      // a drum's blast, against a frag's
  stump: 0.26,      // what is left of it, as a share of its height
  height: 1.05,     // the drum, as it stands
  smoulder: 30,     // seconds a stump smokes
};

const V = new THREE.Vector3();

export class Barrels {
  /**
   * @param {object[]} list `city.fireBarrels`, each carrying its drum and box
   * @param {object} game for `explode`, the world and the effects
   */
  constructor(list, game) {
    this.game = game;
    this.list = list;
    this.meshes = [];
    for (const b of list) {
      b.x = b.drum.position.x;
      b.z = b.drum.position.z;
      b.y = b.drum.position.y;
      b.drum.userData.barrel = b;
      this.meshes.push(b.drum);
    }
    this.reset();
  }

  /** Every drum whole and alight, as a run starts. */
  reset() {
    for (const b of this.list) {
      b.hp = BARREL.hp;
      b.fuse = -1;
      b.burst = false;
      b.by = null;
      b.smoke = 0;
      b.puff = 0;
      b.drum.scale.set(1, 1, 1);
      b.box.top = b.y + BARREL.height;
      b.flame.visible = true;
      if (b.char) this._paint(b, 1);
    }
  }

  /** How many are still standing. */
  get standing() { return this.list.filter((b) => !b.burst).length; }

  /** A round strikes a drum. */
  hit(b, damage, by = 'player') {
    if (b.burst) return;
    b.hp -= damage;
    if (b.hp <= 0 && b.fuse < 0) this.arm(b, BARREL.fuse, by);
  }

  /** Light a drum's fuse, unless one is already burning shorter. */
  arm(b, t, by) {
    if (b.burst || (b.fuse >= 0 && b.fuse <= t)) return;
    if (b.fuse < 0) audio.hiss(V.set(b.x, b.y + 1, b.z));
    b.fuse = t;
    b.by = by;
  }

  /**
   * A blast at `pos` with this reach, set off by `by`: every lit drum it
   * can see goes up after it, a beat later for every metre between them.
   */
  blast(pos, radius, by) {
    const world = this.game.world;
    for (const b of this.list) {
      if (b.burst) continue;
      const d = Math.hypot(b.x - pos.x, b.z - pos.z, b.y + 0.6 - pos.y);
      if (d > radius || d < 0.05) continue;
      // traced to the top of the drum, which a wall it stands behind hides
      if (!world.lineOfSight(pos.x, pos.y + 0.5, pos.z, b.x, b.y + BARREL.height + 0.15, b.z)) continue;
      this.arm(b, BARREL.chain + d * BARREL.perM, by === 'hostile' || by === 'barrel-hostile' ? 'hostile' : 'player');
    }
  }

  update(dt) {
    for (const b of this.list) {
      if (b.fuse >= 0) {
        b.fuse -= dt;
        if (b.fuse <= 0) this.burst(b);
      } else if (b.burst && b.smoke > 0) {
        b.smoke -= dt;
        b.puff -= dt;
        if (b.puff <= 0) {
          b.puff = 0.5 + 0.5 * (1 - b.smoke / BARREL.smoulder);
          this.game.effects.trailPuff(V.set(b.x, b.y + 0.4, b.z));
        }
      }
    }
  }

  /** Blow a drum: the blast, the stump, the fire out. */
  burst(b) {
    if (b.burst) return;
    b.burst = true;
    b.fuse = -1;
    b.smoke = BARREL.smoulder;
    b.puff = 0.8;
    b.flame.visible = false;
    b.light.intensity = 0;
    // crushed and split: a quarter of its height, bulging where it burst
    b.drum.scale.set(1.06, BARREL.stump, 1.06);
    b.drum.updateMatrixWorld();
    b.box.top = b.y + BARREL.height * BARREL.stump;
    this._paint(b, 0.16);
    this.game.explode(new THREE.Vector3(b.x, b.y + 0.55, b.z), b.by === 'hostile' ? 'barrel-hostile' : 'barrel');
  }

  /**
   * Burn a drum's vertex colours toward black, or back. The bake handed
   * each drum its own shaded geometry, so this touches no other drum, and
   * the original shading is kept to put back on a new run.
   */
  _paint(b, k) {
    const col = b.drum.geometry.attributes.color;
    if (!col) return;
    if (!b.char) b.char = col.array.slice();
    for (let i = 0; i < col.array.length; i++) col.array[i] = b.char[i] * k;
    col.needsUpdate = true;
  }
}
