/**
 * Glass in the windows, and what happens to it.
 *
 * A shop's windows and every window of a floor were open holes: right for a
 * city that has been shot at for years, and nothing to break. Now a share
 * of them still hold their pane (`GLASS.share`, a hash of where each window
 * is), and a pane goes when a round passes through it (`alongRay`), when a
 * blast reaches it (`blast`), and when a body goes through it (`touch`) —
 * a pull-up through a shop window, a hostile on a floor. A hostile's shot
 * breaks what it crosses too, so the first shot from a marksman behind a
 * window is heard and seen before it lands.
 *
 * A pane is no obstacle to anything. It is in neither collision list and
 * no reader of the world knows it is there: a sight line, a round, a
 * grenade and the route field all go through a window exactly as they did,
 * which keeps every check of those windows true and the layout untouched.
 * It only *breaks*, which is the point: shooting through glass is the most
 * immediate feedback a city of concrete can give.
 *
 * Drawn, every pane is one instance of one `InstancedMesh`, and every shard
 * in flight one of another, both built in a `reserve` and never baked, so
 * the seeded stream and the bake are untouched and a frame pays two draw
 * calls. What a shard does is decided by a generator of its own, never
 * `Math.random`, which is the city's seed.
 */
import * as THREE from 'three';
import { audio } from './audio.js';
import { SUPPORT_RADIUS } from './world.js';

export const GLASS = {
  share: 0.45,      // of the windows that still hold a pane
  shards: 320,      // in flight and lying at once
  life: 7,          // seconds a shard lies before it is swept
  inset: 0,         // from the middle of the wall's thickness
};

const SHOP_SILL = 0.95;            // a shop window's sill, over its floor
const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** The same hash the city uses for anything decided by where it is. */
function hash2(x, z, salt) {
  let h = (x * 374761393 + z * 668265263 + salt * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A generator of its own, so a shard's flight costs the city's seed nothing. */
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Glass {
  constructor(scene, game) {
    this.game = game;
    this.world = game.world;
    this.rand = mulberry(0x9e3779b9);
    this.broken = 0;            // panes broken this run, for anyone counting
    this.panes = [];
    const world = this.world;
    const add = (w, sill, head, kind) => {
      if (head - sill < 0.6 || w.width < 0.6) return;
      if (hash2(Math.round(w.x * 4), Math.round(w.z * 4), 4177) > GLASS.share) return;
      this.panes.push({
        x: w.x, z: w.z, nx: w.nx, nz: w.nz, tx: -w.nz, tz: w.nx,
        hw: w.width / 2 - 0.02, sill, head, kind, intact: true, index: this.panes.length,
      });
    };
    for (const room of world.rooms) {
      for (const w of room.windows) add(w, room.floor + SHOP_SILL, room.ceiling, 'shop');
    }
    for (const f of world.floors) {
      for (const w of f.windows) add(w, w.sill, w.head, 'floor');
    }

    // one pane, a unit square facing +z, scaled to each window
    const paneMat = new THREE.MeshStandardMaterial({
      color: 0xa8bbb6, roughness: 0.05, metalness: 0.1, envMapIntensity: 1.8,
      transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide,
    });
    paneMat.userData.name = 'pane';
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), paneMat, Math.max(1, this.panes.length));
    this.mesh.name = 'glass';
    this.mesh.count = this.panes.length;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);

    // a shard: a sliver of a triangle, a few centimetres across
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.4, 0, 0.5, -0.25, 0, 0.05, 0.6, 0], 3));
    g.computeVertexNormals();
    const shardMat = new THREE.MeshStandardMaterial({
      color: 0xc8d6d2, roughness: 0.08, metalness: 0.25, envMapIntensity: 2,
      transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide,
    });
    shardMat.userData.name = 'shard';
    this.shardMesh = new THREE.InstancedMesh(g, shardMat, GLASS.shards);
    this.shardMesh.name = 'shards';
    this.shardMesh.count = 0;
    this.shardMesh.frustumCulled = false;
    this.shardMesh.renderOrder = 2;
    this.shardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.shardMesh);
    this.shards = [];
    this.reset();
  }

  /** Every pane back in, every shard swept up, as a run starts. */
  reset() {
    for (const p of this.panes) {
      p.intact = true;
      this._place(p);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.shards.length = 0;
    this.shardMesh.count = 0;
    this.broken = 0;
  }

  get intact() { return this.panes.filter((p) => p.intact).length; }

  _place(p) {
    if (!p.intact) { this.mesh.setMatrixAt(p.index, ZERO); return; }
    E.set(0, Math.atan2(p.nx, p.nz), 0);
    Q.setFromEuler(E);
    P.set(p.x - p.nx * GLASS.inset, (p.sill + p.head) / 2, p.z - p.nz * GLASS.inset);
    S.set(p.hw * 2, p.head - p.sill, 1);
    this.mesh.setMatrixAt(p.index, M.compose(P, Q, S));
  }

  /**
   * A round from `o` along unit `d`, stopping `stop` metres out: every pane
   * it passes through on the way breaks.
   */
  alongRay(o, d, stop) {
    for (const p of this.panes) {
      if (!p.intact) continue;
      const dn = d.x * p.nx + d.z * p.nz;
      if (Math.abs(dn) < 1e-5) continue;
      const s = ((p.x - o.x) * p.nx + (p.z - o.z) * p.nz) / dn;
      if (s < 0 || s > stop) continue;
      const hx = o.x + d.x * s, hy = o.y + d.y * s, hz = o.z + d.z * s;
      if (hy < p.sill || hy > p.head) continue;
      if (Math.abs((hx - p.x) * p.tx + (hz - p.z) * p.tz) > p.hw) continue;
      this.shatter(p, d.x, d.z, hx, hy, hz, 3.2);
    }
  }

  /** A blast at `pos`: every pane it reaches and can see goes, blown away from it. */
  blast(pos, radius) {
    const world = this.world;
    for (const p of this.panes) {
      if (!p.intact) continue;
      const cy = (p.sill + p.head) / 2;
      const d = Math.hypot(p.x - pos.x, cy - pos.y, p.z - pos.z);
      if (d > radius) continue;
      // traced to just in front of the pane on the blast's side
      const side = Math.sign((pos.x - p.x) * p.nx + (pos.z - p.z) * p.nz) || 1;
      const fx = p.x + p.nx * side * 0.3, fz = p.z + p.nz * side * 0.3;
      const fy = Math.min(p.head - 0.1, Math.max(p.sill + 0.1, pos.y));
      if (!world.lineOfSight(pos.x, pos.y + 0.4, pos.z, fx, fy, fz)) continue;
      const k = 1 - d / radius;
      this.shatter(p, -p.nx * side, -p.nz * side, p.x, cy, p.z, 3 + k * 7);
    }
  }

  /**
   * A body at (x, feet, z), `radius` round and `height` tall, moving along
   * (vx, vz): any pane it is pushing through goes.
   */
  touch(x, feet, z, radius, height, vx = 0, vz = 0) {
    for (const p of this.panes) {
      if (!p.intact) continue;
      if (Math.abs(x - p.x) > p.hw + 1.5 || Math.abs(z - p.z) > p.hw + 1.5) continue;
      const off = (x - p.x) * p.nx + (z - p.z) * p.nz;
      if (Math.abs(off) > radius + 0.06) continue;
      if (Math.abs((x - p.x) * p.tx + (z - p.z) * p.tz) > p.hw + radius * 0.5) continue;
      if (feet > p.head - 0.2 || feet + height < p.sill + 0.1) continue;
      const v = Math.hypot(vx, vz);
      const dx = v > 0.1 ? vx / v : -Math.sign(off) * p.nx, dz = v > 0.1 ? vz / v : -Math.sign(off) * p.nz;
      this.shatter(p, dx, dz, x, Math.min(p.head - 0.3, Math.max(p.sill + 0.3, feet + 1.2)), z, 1.6 + v * 0.5);
    }
  }

  /**
   * Break a pane: gone from the window, and its glass thrown along
   * (dx, dz) from the point it went at, at up to `speed`.
   */
  shatter(p, dx, dz, hx, hy, hz, speed) {
    if (!p.intact) return;
    p.intact = false;
    this.broken++;
    this._place(p);
    this.mesh.instanceMatrix.needsUpdate = true;

    const r = this.rand, world = this.world;
    const area = p.hw * 2 * (p.head - p.sill);
    const n = Math.round(Math.min(30, Math.max(10, area * 7)));
    for (let i = 0; i < n; i++) {
      // from across the pane, most of it near where it was struck
      const near = r() < 0.55;
      const a = near ? (hx - p.x) * p.tx + (hz - p.z) * p.tz + (r() - 0.5) * 0.6 : (r() * 2 - 1) * p.hw;
      const y = near ? hy + (r() - 0.5) * 0.6 : p.sill + r() * (p.head - p.sill);
      const sx = p.x + p.tx * a, sz = p.z + p.tz * a;
      const sy = Math.min(p.head, Math.max(p.sill + 0.02, y));
      const sp = speed * (0.25 + r() * 0.75) * (near ? 1 : 0.45);
      const vx = dx * sp + (r() - 0.5) * 1.2, vz = dz * sp + (r() - 0.5) * 1.2, vy = (r() - 0.3) * 1.8;
      // where it comes down, worked out at the spawn: the floor under where
      // it falls to, asked again from there until it settles (an upstairs
      // pane blown outward lands in the street, not on the floor it fell from)
      let ground = world.groundHeight(sx, sz, SUPPORT_RADIUS, sy);
      for (let k = 0; k < 3; k++) {
        const t = (vy + Math.sqrt(vy * vy + 44 * Math.max(0, sy - ground))) / 22;
        ground = world.groundHeight(sx + vx * t, sz + vz * t, SUPPORT_RADIUS, sy);
      }
      this._spawn(sx, sy, sz, vx, vy, vz, 0.035 + r() * 0.07, ground + 0.004);
    }
    const pl = this.game.player.position;
    const dist = Math.hypot(pl.x - p.x, pl.y - hy, pl.z - p.z);
    audio.glass(P.set(p.x, hy, p.z), Math.min(1, Math.max(0.12, 9 / Math.max(3, dist))), this.broken);
  }

  _spawn(x, y, z, vx, vy, vz, size, ground) {
    let s;
    if (this.shards.length < GLASS.shards) { s = {}; this.shards.push(s); }
    else s = this.shards.reduce((a, b) => (a.age > b.age ? a : b));     // the oldest goes
    const r = this.rand;
    Object.assign(s, {
      x, y, z, vx, vy, vz, size, ground, age: 0, landed: false,
      rx: r() * 6, ry: r() * 6, rz: r() * 6,
      wx: (r() - 0.5) * 30, wy: (r() - 0.5) * 30, wz: (r() - 0.5) * 30,
    });
  }

  update(dt) {
    const list = this.shards;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      s.age += dt;
      if (s.age > GLASS.life) { list.splice(i, 1); continue; }
      if (s.landed) continue;
      const was = s.y;
      s.vy -= 22 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.rx += s.wx * dt; s.ry += s.wy * dt; s.rz += s.wz * dt;
      if (s.y <= s.ground) {
        // lies flat where it fell, on the floor that is really under it
        s.y = this.world.groundHeight(s.x, s.z, SUPPORT_RADIUS, Math.max(was, s.ground) + 0.02) + 0.004;
        s.landed = true;
        s.rx = -Math.PI / 2; s.rz = 0;
      }
    }
    const m = this.shardMesh;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const fade = Math.min(1, (GLASS.life - s.age) / 1.2);
      E.set(s.rx, s.ry, s.rz);
      Q.setFromEuler(E);
      P.set(s.x, s.y, s.z);
      S.setScalar(s.size * fade);
      m.setMatrixAt(i, M.compose(P, Q, S));
    }
    m.count = list.length;
    if (list.length) m.instanceMatrix.needsUpdate = true;
  }
}
