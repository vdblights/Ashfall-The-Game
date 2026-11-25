import * as THREE from 'three';
import { WHEEL } from './city.js';
import { SUPPORT_RADIUS } from './world.js';
import { audio } from './audio.js';

/**
 * The pickup: the one car in Carrow that still runs.
 *
 * It is the wreck's own shape (`carShapes(true)`) with its wheels apart so
 * they turn, a collider that moves (`World.addMover`) so to a body, a round, a
 * grenade and a sight line it is a parked car wherever it has got to, and a
 * seat. Driving owns the player the way a pull-up does: `Player.update`
 * returns early while `player.vehicle` is set, and this puts the eye in the
 * cab and the camera behind it. Nothing here draws on `Math.random`, and the
 * whole of it is built inside a `reserve`, so it costs the seed nothing.
 */
export const TRUCK = {
  top: 17,          // m/s, about 60 km/h: the length of the sector in 16 s
  reverse: 5.5,
  accel: 10,
  brake: 16,
  roll: 1.2,        // rolling resistance, m/s²
  drag: 0.018,      // and air, per (m/s)²
  wheelbase: 2.72,
  steer: 0.6,       // rad at the front wheels, standing; less at speed
  hp: 600,
  half: { x: 0.95, z: 2.2 },
  height: 1.5,
  circle: 0.95,     // three circles down its length are what meets the world
  step: 0.42,       // a kerb is driven over; a heap's tier too
  reach: 2.8,       // how near the door you have to be to get in
  ram: 3.5,         // m/s under which a hostile is an obstacle, not a target
  ramHit: 1.4,      // damage a (m/s)² of closing speed
  crash: 4,         // m/s into a wall before the truck takes damage
  seat: { x: -0.38, y: 1.25, z: -0.15 },
  feet: 0.35,
  camera: { dist: 6.2, rise: 1.6, pitchMin: -0.9, pitchMax: 0.3, settle: 0.8 },
  burn: 2.2,        // seconds from the last of its health to the fuel going up
  // of what a hostile's round would do to you in the cab, the share you take
  shelter: 0.35,
};

const V = new THREE.Vector3();
const P = new THREE.Vector3();
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Truck {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    const set = game.propShapes.cars.pickup;
    const mats = game.paintedMaterials;

    // its own copies: moving steel must not wear the ash the city has
    // settled on it, which is fixed in world space and would slide over it
    const own = (m, tint) => {
      const c = m.clone();
      if (c.defines) { c.defines = { ...c.defines }; delete c.defines.ASH_SETTLE; }
      if (tint !== undefined) c.color = new THREE.Color(tint);
      c.needsUpdate = true;
      return c;
    };
    const paint = own(mats.carBodyMats[2]);
    const glass = own(mats.glassMat);
    const trim = own(mats.metalMat);
    const tire = own(mats.tireMat);
    const burnt = own(mats.burntMat);

    this.group = new THREE.Group();
    this.group.name = 'pickup';
    this.body = new THREE.Group();
    this.body.rotation.order = 'YXZ';
    this.group.add(this.body);
    const add = (geo, mat, parent = this.body) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    // the body is lifted by the ground under its wheels, the wheels are
    // where its suspension holds them
    this.panels = add(set.panels, paint);
    this.cabin = add(set.cabin, glass);
    this.trim = add(set.trim, trim);
    this.wells = add(set.wells, tire);
    // A burnt-out pickup is the same panels in charred steel. It is built
    // now and hidden, because the boot compile shows every hidden mesh it
    // finds: a material first drawn when the truck goes up would compile in
    // the middle of the fight that blew it.
    this.burntParts = [add(set.panels, burnt), add(set.cabin, burnt), add(set.trim, burnt)];
    for (const m of this.burntParts) m.visible = false;

    this.wheels = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.rotation.order = 'YXZ';
        pivot.position.set(sx * WHEEL.x, WHEEL.cy, sz * WHEEL.z);
        const m = add(set.wheel, tire, pivot);
        m.rotation.y = sx * Math.PI / 2;
        this.body.add(pivot);
        this.wheels.push({ pivot, front: sz > 0, sx, sz });
      }
    }

    this.box = this.world.addMover(TRUCK.half.x, TRUCK.half.z, TRUCK.height);
    this.pos = new THREE.Vector3();
    this.spot = this.findSpot(game.insertion, game.streets);
    this.hint = '';
    this.reset();
  }

  /** What a round can stop at: the cab and the panels, or the shell. */
  get meshes() { return this.dead ? this.burntParts.slice(0, 2) : [this.panels, this.cabin]; }

  /**
   * Where it is parked at the start of a run: in a lane of the nearest
   * street to the insertion point, on a stretch that is level, clear of
   * every collider and on the road. Read off the city as built, drawing
   * nothing, so every seed parks it somewhere and no seed moves for it.
   */
  findSpot(from, streets) {
    const w = this.world, H = TRUCK.half;
    const cands = [];
    for (const c of streets.centres) {
      for (const lane of [-1.5, 1.5]) {
        for (let t = -streets.end + 4; t <= streets.end - 4; t += 1) {
          // a street along x at z = c, and one along z at x = c; it drives
          // on the right, so it is parked facing the way its lane runs
          cands.push({ x: t, z: c + lane, yaw: lane > 0 ? Math.PI / 2 : -Math.PI / 2 });
          cands.push({ x: c + lane, z: t, yaw: lane > 0 ? Math.PI : 0 });
        }
      }
    }
    for (const k of cands) k.d = Math.hypot(k.x - from.x, k.z - from.z);
    cands.sort((a, b) => a.d - b.d);
    const junction = (v) => streets.centres.some((c) => Math.abs(v - c) < streets.half + 5);
    for (const k of cands) {
      // not across a junction, where it would block both streets
      if (k.yaw === Math.PI / 2 || k.yaw === -Math.PI / 2 ? junction(k.x) : junction(k.z)) continue;
      const cos = Math.cos(k.yaw), sin = Math.sin(k.yaw);
      const at = (lx, lz) => [k.x + cos * lx + sin * lz, k.z - sin * lx + cos * lz];
      let ok = true, lo = Infinity, hi = -Infinity;
      for (let i = -1; i <= 1 && ok; i += 1) {
        for (let j = -2; j <= 2 && ok; j += 1) {
          const [x, z] = at(i * H.x, j * H.z / 2);
          if (w.blocked(x, z, 0.35, 0.3)) ok = false;
          const g = w.groundHeight(x, z, 0.2, 0.6);
          lo = Math.min(lo, g); hi = Math.max(hi, g);
        }
      }
      if (ok && hi - lo < 0.03 && hi < 0.1) return k;
    }
    return { x: from.x, z: from.z + 10, yaw: Math.PI / 2 };
  }

  reset() {
    if (this.driver) this.driver.vehicle = null;
    this.driver = null;
    this.pos.set(this.spot.x, 0, this.spot.z);
    this.pos.y = this.world.groundHeight(this.spot.x, this.spot.z, 0.3, 0.6);
    this.yaw = this.spot.yaw;
    this.v = 0;
    this.vy = 0;
    this.steer = 0;
    this.pitch = 0;
    this.roll = 0;
    this.spin = 0;
    this.hp = TRUCK.hp;
    this.dead = false;
    this.burnAt = -1;
    this.blown = false;
    this.lastLook = -99;
    this.crashes = 0;
    this.rams = 0;
    this.hint = '';
    this.panels.visible = this.cabin.visible = this.trim.visible = true;
    for (const m of this.burntParts) m.visible = false;
    this._place();
  }

  /** Whether the player is near enough a door to get in. */
  inReach(player) {
    if (this.dead || player.dead || player.mantle || player.vehicle) return false;
    const dx = player.position.x - this.pos.x, dz = player.position.z - this.pos.z;
    if (Math.abs(player.feetY - this.pos.y) > 1.2) return false;
    return Math.hypot(dx, dz) < TRUCK.reach;
  }

  enter(player) {
    if (!this.inReach(player)) return false;
    this.driver = player;
    player.vehicle = this;
    player.velocity.set(0, 0, 0);
    player.slide = null;
    player.lean = 0;
    player.leanOffset.set(0, 0, 0);
    player.crouching = player.sprinting = false;
    player.yaw = this.yaw + Math.PI;
    player.pitch = -0.18;
    this.lastLook = -99;
    this.game.weapons.adsT = 0;
    audio.door(this.pos.clone().setY(this.pos.y + 1), false);
    return true;
  }

  /**
   * Out by the driver's door, or the other, or behind, or in front: the
   * first that has room for a body and ground it can stand on.
   */
  exit(force = false) {
    const p = this.driver;
    if (!p) return false;
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    const sx = Math.sign(TRUCK.seat.x) || -1;
    const ways = [[sx * 1.6, 0.2], [-sx * 1.6, 0.2], [0, -3.0], [0, 3.0], [sx * 2.4, 1.5], [-sx * 2.4, -1.5]];
    for (const [lx, lz] of ways) {
      const x = this.pos.x + cos * lx + sin * lz, z = this.pos.z - sin * lx + cos * lz;
      if (this.world.blocked(x, z, p.radius, this.pos.y + 0.6)) continue;
      const h = this.world.groundHeight(x, z, SUPPORT_RADIUS, this.pos.y + 1.2);
      if (h < this.pos.y - 1.5) continue;
      this._stand(p, x, h, z);
      return true;
    }
    if (!force) { this.game.hud.toast('NO ROOM TO GET OUT'); return false; }
    // nowhere beside it: out through the roof
    this._stand(p, this.pos.x, this.pos.y + TRUCK.height, this.pos.z);
    return true;
  }

  _stand(p, x, h, z) {
    p.vehicle = null;
    this.driver = null;
    p.feetY = h;
    p.fallTop = h;
    p.eyeHeight = 1.68;
    p.position.set(x, h + p.eyeHeight, z);
    p.velocity.set(0, 0, 0);
    p.onGround = true;
    p.yaw = wrap(p.yaw);
    p.pitch = THREE.MathUtils.clamp(p.pitch, -0.6, 0.4);
    audio.door(this.pos.clone().setY(this.pos.y + 1), true);
  }

  /** Damage to the truck itself, from a round, a blast or a wall. */
  damage(amount) {
    if (this.dead || amount <= 0) return;
    this.hp -= amount;
    if (this.hp > 0) return;
    this.hp = 0;
    this.dead = true;
    this.burnAt = this.game.time;
    if (this.driver) this.exit(true);
    this.panels.visible = this.cabin.visible = this.trim.visible = false;
    for (const m of this.burntParts) m.visible = true;
    this.game.hud.toast('THE PICKUP IS BURNING');
  }

  /**
   * One step. Driven, it reads the keys or the stick; left alone it rolls to
   * a stop. Either way it meets the world through three circles down its
   * length, stands on the ground under its four wheels, and runs over what
   * it reaches fast enough.
   */
  update(dt, time, input) {
    const game = this.game, p = this.driver, T = TRUCK;
    if (p && p.dead) { p.vehicle = null; this.driver = null; }
    const driving = !!this.driver;

    // ---- the fuel going up -------------------------------------------------
    if (this.dead && !this.blown && time - this.burnAt >= T.burn) {
      this.blown = true;
      game.explode(this.pos.clone().setY(this.pos.y + 0.8), 'barrel');
    }

    // ---- intent ------------------------------------------------------------
    let thr = 0, turn = 0, handbrake = false;
    if (driving) {
      if (input.down('KeyW')) thr += 1;
      if (input.down('KeyS')) thr -= 1;
      if (input.down('KeyA')) turn += 1;
      if (input.down('KeyD')) turn -= 1;
      if (input.pad) { thr -= input.pad.move.y; turn -= input.pad.move.x; }
      thr = THREE.MathUtils.clamp(thr, -1, 1);
      turn = THREE.MathUtils.clamp(turn, -1, 1);
      handbrake = input.down('Space');
    }
    if (this.dead) { thr = 0; turn = 0; }

    const grounded = this.vy === 0;
    let v = this.v;
    if (grounded) {
      let a = 0;
      if (thr > 0) a = v < -0.2 ? T.brake : T.accel * thr * Math.max(0, 1 - v / T.top);
      else if (thr < 0) a = v > 0.2 ? -T.brake : T.accel * 0.7 * thr * Math.max(0, 1 + v / T.reverse);
      const resist = T.roll + T.drag * v * v + (handbrake ? T.brake * 1.1 : 0) + (driving ? 0 : T.brake * 0.5);
      const before = v;
      v += a * dt;
      if (v !== 0) {
        const dv = Math.min(Math.abs(v), resist * dt);
        // resistance never pushes a stopped truck backwards
        v -= Math.sign(v) * dv;
      }
      if (thr === 0 && Math.sign(v) !== Math.sign(before) && before !== 0) v = 0;
    }
    const want = turn * T.steer / (1 + Math.abs(v) / 12);
    this.steer = THREE.MathUtils.damp(this.steer, want, 6, dt);
    if (grounded) this.yaw = wrap(this.yaw + (v / T.wheelbase) * Math.tan(this.steer) * dt);

    // ---- move, a piece at a time -------------------------------------------
    this.box.off = true;
    const total = v * dt;
    const n = Math.max(1, Math.ceil(Math.abs(total) / 0.35));
    let impact = 0;
    for (let i = 0; i < n; i++) {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const px = this.pos.x, pz = this.pos.z;
      this.pos.x += fx * v * dt / n;
      this.pos.z += fz * v * dt / n;
      this.slowBy = 1;
      if (this._ram(v, time)) { this.pos.x = px; this.pos.z = pz; v = 0; break; }
      v *= this.slowBy;
      const hit = this._collide();
      if (hit) {
        // what drove into the wall stops; what ran along it keeps going
        const into = (fx * v) * hit.x + (fz * v) * hit.z;
        if (into < 0) {
          impact = Math.max(impact, -into);
          const ux = fx * v - hit.x * into, uz = fz * v - hit.z * into;
          v = ux * fx + uz * fz;
        }
      }
    }
    this.world.clampToBounds(this.pos, T.half.z);
    this.v = v;
    if (impact > T.crash) this._crashed(impact);

    // ---- stand on what is under the wheels ---------------------------------
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    const under = (lx, lz) => this.world.groundHeight(this.pos.x + cos * lx + sin * lz,
      this.pos.z - sin * lx + cos * lz, 0.2, this.pos.y + 0.45);
    const fl = under(WHEEL.x, WHEEL.z), fr = under(-WHEEL.x, WHEEL.z);
    const rl = under(WHEEL.x, -WHEEL.z), rr = under(-WHEEL.x, -WHEEL.z);
    const ground = (fl + fr + rl + rr) / 4;
    const pitch = Math.atan2((fl + fr) - (rl + rr), 2 * 2 * WHEEL.z);
    const roll = Math.atan2((fl + rl) - (fr + rr), 2 * 2 * WHEEL.x);
    if (this.pos.y <= ground + 0.02 || (grounded && this.pos.y - ground < 0.35)) {
      if (this.vy < -7) this._crashed(-this.vy * 0.8);
      // down a kerb it eases, up one it is lifted at once: it is never in it
      this.pos.y = ground > this.pos.y ? ground : THREE.MathUtils.damp(this.pos.y, ground, 18, dt);
      this.vy = 0;
    } else {
      this.vy -= 19 * dt;
      this.pos.y = Math.max(ground, this.pos.y + this.vy * dt);
    }
    this.pitch = THREE.MathUtils.damp(this.pitch, pitch, 10, dt);
    this.roll = THREE.MathUtils.damp(this.roll, roll, 10, dt);
    this.spin += (v / WHEEL.r) * dt;
    this.box.off = false;
    this._place();

    // ---- the cab and the view out of it -------------------------------------
    if (this.driver) this._seat(this.driver, dt, time, input);
    this._sound(driving);
    this.hint = this.driver
      ? `PICKUP ${Math.round(100 * this.hp / T.hp)}% · ${Math.round(Math.abs(v) * 3.6)} KM/H · [E] GET OUT`
      : (this.inReach(game.player) ? '[E] DRIVE' : '');
  }

  /**
   * The push the world gives the truck: each of the three circles is walked
   * out of whatever it is in, three times over, and the largest push taken.
   * Returns the unit normal of the last push, or null.
   */
  _collide() {
    const T = TRUCK;
    let normal = null;
    for (let it = 0; it < 3; it++) {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      let best = 0, bx = 0, bz = 0;
      for (const lz of [-1.3, 0, 1.3]) {
        P.set(this.pos.x + fx * lz, 0, this.pos.z + fz * lz);
        const ox = P.x, oz = P.z;
        this.world.resolve(P, T.circle, this.pos.y, T.step, 1.6);
        const dx = P.x - ox, dz = P.z - oz, d = dx * dx + dz * dz;
        if (d > best) { best = d; bx = dx; bz = dz; }
      }
      if (best < 1e-8) break;
      this.pos.x += bx; this.pos.z += bz;
      const l = Math.sqrt(best);
      normal = { x: bx / l, z: bz / l };
    }
    return normal;
  }

  /**
   * Hostiles in its way. Fast enough, it runs them down — damage by the
   * square of its speed, the blow thrown the way it was going, and the kill
   * the player's; slower, or a holdout, and it stops against them.
   */
  _ram(v, time) {
    const g = this.game, T = TRUCK;
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    let stop = false;
    for (const e of g.enemies) {
      if (!e.alive) continue;
      if (e.pos.y > this.pos.y + T.height || e.pos.y < this.pos.y - 1) continue;
      const rx = e.pos.x - this.pos.x, rz = e.pos.z - this.pos.z;
      const lx = cos * rx - sin * rz, lz = sin * rx + cos * rz;
      const r = e.radius || 0.45;
      if (Math.abs(lx) > T.half.x + r || Math.abs(lz) > T.half.z + r) continue;
      // only what is ahead of the way it is going
      if (lz * Math.sign(v || 1) < T.half.z * 0.3) continue;
      if (Math.abs(v) < T.ram || e.type.friendly || this.dead) { stop = true; continue; }
      if ((e._rammedAt ?? -9) > time - 0.6) continue;
      e._rammedAt = time;
      const s = Math.sign(v);
      V.set(Math.sin(this.yaw) * s, 0, Math.cos(this.yaw) * s);
      const result = e.damage(T.ramHit * v * v, 'body', V.clone(), e.pos.clone().setY(e.pos.y + 1),
        THREE.MathUtils.clamp(Math.abs(v) / 12, 0.3, 1.5));
      g.registerHit(e, result, 'PICKUP', false);
      this.rams++;
      audio.crash(0.6, e.pos.clone().setY(e.pos.y + 1));
      if (g.player) g.player.addShake(0.15);
      // a body takes some of the speed off; a juggernaut takes more
      this.slowBy *= e.type.hp > 300 ? 0.55 : 0.85;
      this.damage(e.type.hp > 300 ? 25 : 6);
    }
    return stop;
  }

  _crashed(speed) {
    this.crashes++;
    const dmg = (speed - TRUCK.crash + 1) * 14;
    this.damage(dmg);
    audio.crash(Math.min(1, speed / 12), this.pos.clone().setY(this.pos.y + 0.8));
    if (this.driver) {
      this.driver.addShake(Math.min(0.7, speed / 18));
      this.game.damagePlayer(dmg * 0.12, null, true);
    }
  }

  _place() {
    this.world.placeMover(this.box, this.pos.x, this.pos.z, this.yaw, this.pos.y);
    this.group.position.copy(this.pos);
    this.body.rotation.set(-this.pitch, this.yaw, this.roll, 'YXZ');
    for (const w of this.wheels) {
      w.pivot.rotation.x = this.spin;
      w.pivot.rotation.y = w.front ? this.steer : 0;
    }
    // hit detection runs before the renderer brings matrices up to date
    this.group.updateMatrixWorld(true);
  }

  /**
   * The player in the cab: the eye on the seat, so what hostiles look for and
   * shoot at is in the truck, and the camera behind it, on the mouse's yaw
   * and pitch and pulled in wherever a wall stands between it and the truck.
   */
  _seat(p, dt, time, input) {
    const T = TRUCK, C = T.camera;
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    const s = T.seat;
    p.feetY = this.pos.y + T.feet;
    p.fallTop = p.feetY;
    p.position.set(this.pos.x + cos * s.x + sin * s.z, this.pos.y + s.y, this.pos.z - sin * s.x + cos * s.z);
    p.velocity.set(Math.sin(this.yaw) * this.v, 0, Math.cos(this.yaw) * this.v);
    p.onGround = true;

    // left alone a moment, the view comes round behind the truck
    if (input.lookDelta.x !== 0 || input.lookDelta.y !== 0 || (input.pad && (input.pad.look.x || input.pad.look.y))) this.lastLook = time;
    if (time - this.lastLook > C.settle && Math.abs(this.v) > 2) {
      const behind = this.yaw + Math.PI;
      p.yaw += wrap(behind - p.yaw) * (1 - Math.exp(-2.5 * dt));
    }
    p.pitch = THREE.MathUtils.clamp(p.pitch, C.pitchMin, C.pitchMax);

    const cam = p.camera;
    const cp = Math.cos(p.pitch);
    const lx = -Math.sin(p.yaw) * cp, ly = Math.sin(p.pitch), lz = -Math.cos(p.yaw) * cp;
    const fx = this.pos.x, fy = this.pos.y + C.rise, fz = this.pos.z;
    let d = C.dist;
    this.box.off = true;
    const clear = (k) => this.world.lineOfSight(fx, fy, fz, fx - lx * k, fy - ly * k + 0.5, fz - lz * k);
    if (!clear(d)) {
      let lo = 0, hi = d;
      for (let i = 0; i < 6; i++) { const m = (lo + hi) / 2; if (clear(m)) lo = m; else hi = m; }
      d = Math.max(1.2, lo - 0.3);
    }
    this.box.off = false;
    p.shake = Math.max(0, p.shake - dt * 1.6);
    cam.position.set(fx - lx * d, fy - ly * d + 0.5, fz - lz * d);
    cam.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
  }

  _sound(driving) {
    const on = driving && this.game.state === 'playing';
    if (!on && !this.sounding) return;
    this.sounding = on;
    audio.engine(on ? 0.28 + 0.2 * Math.min(1, Math.abs(this.v) / TRUCK.top) : 0, Math.min(1, Math.abs(this.v) / TRUCK.top));
  }

  /** Silence, for whenever the game stops stepping: a pause, the end. */
  quiet() {
    if (this.sounding) { this.sounding = false; audio.engine(0, 0); }
  }
}
