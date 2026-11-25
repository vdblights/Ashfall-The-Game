import * as THREE from 'three';
import * as TEX from './textures.js';
import { TILE } from './textures.js';
import { chamferGeo, planarUV, mergeIntoOne } from './shapes.js';
import { SUPPORT_RADIUS } from './world.js';
import { audio } from './audio.js';

/**
 * Fortifying the depot: what Act III's armoury sells for the convoy.
 *
 * Sandbags, wire and a mounted gun are bought between waves from wave 8 on
 * (`depotOnShelf` in armoury.js), like any other kit, and nothing of them is in the city
 * until the convoy's objective starts: then `raise` puts them round the
 * depot it was given, and `strike` takes them down when it ends, won or
 * lost. A lost convoy comes again, and the kit goes up again with it.
 *
 * Everything is built once, at boot, inside the caller's `reserve`, and is
 * only moved and shown after that, so a purchase and a raise cost the seed
 * nothing; nothing here draws on `Math.random` either: where each piece
 * goes is worked out from the site and the city as built, and the gun's
 * spread off a counter. Three kinds of thing, and each is what it looks
 * like to every reader:
 *
 * - **A sandbag wall is a collider that is not in the box list**: a mover
 *   (`World.addMover`), the pickup's kind, waist-high, so it is cover to
 *   every sight line, round, grenade and body, and a round from you stops in
 *   its meshes (`meshes`, read by `Game.hitscan`). A wall not raised is
 *   `off`, which every reader skips.
 * - **Wire is not a collider.** It is seen at body height and walked
 *   through, slowly: a hostile in a coil is snared (`snaredUntil`, which
 *   `Enemy` reads where it reads its speed) and cut, and a kill it makes is
 *   yours. Your own wire you know the way through.
 * - **The gun is a seat**, the pickup's other kind: `E` beside it puts you
 *   behind it (`player.vehicle`, with `gun` set, so the body is held and
 *   your own weapon is put away), the view on its sight, its traverse
 *   limited to the arc in front of it. It fires as long as the trigger is
 *   held and the barrel is not too hot, and its shield takes most of what
 *   comes at you from in front.
 */
export const DEPOT = {
  // sandbags: how many walls each tier raises, on a ring inside the depot
  walls: [0, 4, 8], wallR: 4.7, wallLen: 2.2, wallDepth: 0.62, wallTop: 1.0,
  // wire: how many coils each tier lays, on a ring outside it
  wires: [0, 3, 6], wireR: 10.5, wireLen: 3.4, wireRad: 0.42,
  wire: { slow: 0.35, dps: 14, tick: 0.25 },
  gun: {
    rate: 0.085,          // s between rounds, about 700 a minute
    heat: 0.045,          // of the barrel's limit, a round: about six seconds held
    cool: 0.34,           // a second
    recover: 0.4,         // an overheated barrel fires again under this
    traverse: 1.25,       // rad either side of where it faces
    pitchMin: -0.32, pitchMax: 0.42,
    pivot: 1.14, back: 0.8, up: 0.3,    // the sight, from the pintle
    reach: 1.7,           // how near you have to be to take it
    shelter: 0.4,         // of a hit from in front, the share you take
    front: 1.05,          // rad either side the shield covers
    spread: 0.009,
    out: 2.4,             // how far toward the street from the depot's middle
  },
};

/** What the mounted gun shoots, in the shape `Game.hitscan` reads. */
export const GUN_DEF = {
  id: 'mg', name: 'M240 MOUNTED', damage: 40, headMult: 2.2, pellets: 1, range: 190, tracer: 1.3,
};


const V = new THREE.Vector3();
const _down = new THREE.Vector3(), _knee = new THREE.Vector3();
const D = new THREE.Vector3();
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

/** One bag: a pillow, flat where it lies on the one under it. */
function bagGeo(len, wide, n) {
  const g = new THREE.SphereGeometry(1, 9, 6).toNonIndexed();
  const p = g.attributes.position;
  const sag = 0.85 + hash(n) * 0.25;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.min(1, Math.hypot(x, z));
    p.setXYZ(i, x * len / 2 * (0.92 + 0.08 * r), Math.max(-0.1, Math.min(0.1 * sag, y * 0.14)), z * wide / 2);
  }
  g.computeVertexNormals();
  return planarUV(g, TILE.kit);
}

/** A wall of bags, two deep and five courses high, its middle at the origin. */
function wallGeo() {
  const L = DEPOT.wallLen, W = DEPOT.wallDepth, rows = 5, h = DEPOT.wallTop / rows;
  const geos = [];
  let n = 0;
  for (let c = 0; c < rows; c++) {
    const shift = c % 2 ? 0.3 : 0;
    for (const side of [-1, 1]) {
      for (let x = -L / 2 + 0.3 + shift; x <= L / 2 - 0.25; x += 0.6) {
        const g = bagGeo(0.6, W / 2, n++);
        g.rotateY((hash(n * 3.1) - 0.5) * 0.12);
        g.translate(x, h * (c + 0.5), side * W / 4);
        geos.push(g);
      }
    }
  }
  return mergeIntoOne(geos);
}

/** A coil of concertina wire along X, its middle at the origin, with a picket at each end. */
function wireGeo() {
  const L = DEPOT.wireLen, R = DEPOT.wireRad, turns = 26;
  class Helix extends THREE.Curve {
    getPoint(t, out = new THREE.Vector3()) {
      const a = t * turns * Math.PI * 2;
      const wob = 1 + 0.08 * Math.sin(a * 0.37);
      return out.set(-L / 2 + t * L, R + Math.sin(a) * R * wob, Math.cos(a) * R * wob);
    }
  }
  const coil = new THREE.TubeGeometry(new Helix(), turns * 10, 0.006, 3, false).toNonIndexed();
  planarUV(coil, TILE.metal);
  const geos = [coil];
  for (const s of [-1, 1]) geos.push(chamferGeo(0.035, 1.0, 0.035, 0.008, TILE.metal, [s * L / 2, 0.5, 0]));
  return mergeIntoOne(geos);
}

/** A rod from a to b, for the tripod. */
function rod(a, b, r) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 6).toNonIndexed();
  planarUV(g, TILE.metal);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), D.copy(b).sub(a).normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

function tube(r, len, z, y = 0, sides = 10) {
  const g = new THREE.CylinderGeometry(r, r, len, sides).toNonIndexed();
  g.rotateX(Math.PI / 2);
  g.translate(0, y, z);
  return planarUV(g, TILE.metal);
}

export class Depot {
  constructor(game) {
    this.game = game;
    this.gun = true;          // a seat, not a vehicle: the HUD and the keys ask
    this.world = game.world;
    this.group = new THREE.Group();
    this.group.name = 'depot';

    const sackTex = TEX.fatigues();
    const sack = new THREE.MeshStandardMaterial({
      color: 0xb59d74, map: sackTex,
      normalMap: TEX.normalFrom(sackTex, 1.3, 'fatigues', 1), normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 1, metalness: 0, envMapIntensity: 0.6,
    });
    const steelTex = TEX.gunMetal();
    const steel = new THREE.MeshStandardMaterial({
      color: 0x8b9198, map: steelTex, normalMap: TEX.normalFrom(steelTex, 1.2, 'gunmetal', 1),
      roughness: 0.62, metalness: 0.6, envMapIntensity: 0.8,
    });
    const paintTex = TEX.paintedMetal();
    const olive = new THREE.MeshStandardMaterial({
      color: 0x4c5135, map: paintTex, roughness: 0.72, metalness: 0.2, envMapIntensity: 0.6,
    });
    const wireMat = new THREE.MeshStandardMaterial({ color: 0x7c7a76, roughness: 0.45, metalness: 0.85 });

    const wall = wallGeo();
    this.walls = [];
    for (let i = 0; i < DEPOT.walls[DEPOT.walls.length - 1]; i++) {
      const mesh = new THREE.Mesh(wall, sack);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.visible = false;
      this.group.add(mesh);
      const box = this.world.addMover(DEPOT.wallLen / 2, DEPOT.wallDepth / 2, DEPOT.wallTop);
      box.off = true;
      box.sandbags = true;
      this.walls.push({ mesh, box, up: false });
    }

    const coil = wireGeo();
    this.wires = [];
    for (let i = 0; i < DEPOT.wires[DEPOT.wires.length - 1]; i++) {
      const mesh = new THREE.Mesh(coil, wireMat);
      mesh.castShadow = true;
      mesh.visible = false;
      this.group.add(mesh);
      this.wires.push({ mesh, up: false, x: 0, z: 0, y: 0, cos: 1, sin: 0 });
    }

    this.buildGun(steel, olive);
    this.meshes = [];
    this.reset();
  }

  /**
   * A medium machine gun on a tripod, behind a shield with a slot to see
   * through. The tripod and pintle stand; the gun and shield turn about
   * the pintle (`pivot`), built pointing -z as the camera looks.
   */
  buildGun(steel, olive) {
    const G = DEPOT.gun;
    this.gunRoot = new THREE.Group();
    this.gunRoot.visible = false;
    this.group.add(this.gunRoot);

    const top = new THREE.Vector3(0, G.pivot - 0.14, 0);
    const legs = [[0, -0.62], [0.52, 0.42], [-0.52, 0.42]].map(([x, z]) => rod(top, new THREE.Vector3(x, 0.02, z), 0.022));
    legs.push(rod(top, new THREE.Vector3(0, G.pivot - 0.02, 0), 0.032));
    const stand = new THREE.Mesh(mergeIntoOne(legs), steel);
    stand.castShadow = stand.receiveShadow = true;
    this.gunRoot.add(stand);

    this.pivot = new THREE.Group();
    this.pivot.rotation.order = 'YXZ';
    this.pivot.position.y = G.pivot;
    this.gunRoot.add(this.pivot);
    const metal = [
      chamferGeo(0.12, 0.13, 0.66, 0.015, TILE.metal, [0, 0.0, -0.02]),       // receiver
      chamferGeo(0.10, 0.04, 0.3, 0.01, TILE.metal, [0, 0.085, 0.05]),       // feed cover
      tube(0.021, 0.9, -0.78, 0.015),                                         // barrel
      tube(0.036, 0.34, -0.48, 0.015),                                        // its jacket
      tube(0.03, 0.09, -1.25, 0.015, 8),                                      // flash hider
      chamferGeo(0.03, 0.12, 0.03, 0.006, TILE.metal, [0.06, -0.02, 0.33]),   // spade grips
      chamferGeo(0.03, 0.12, 0.03, 0.006, TILE.metal, [-0.06, -0.02, 0.33]),
      chamferGeo(0.15, 0.025, 0.025, 0.005, TILE.metal, [0, -0.06, 0.33]),
      chamferGeo(0.02, 0.07, 0.02, 0.004, TILE.metal, [0, 0.1, -0.3]),        // the sight's post
      chamferGeo(0.05, 0.05, 0.012, 0.004, TILE.metal, [0, 0.1, 0.18]),       // and its leaf
    ];
    const painted = [
      chamferGeo(0.12, 0.15, 0.22, 0.012, TILE.metal, [-0.13, -0.05, -0.04]), // the ammunition box
      // the shield: a plate to the chest of someone kneeling behind it, and
      // an ear either side of the gun, low enough to look over
      chamferGeo(0.82, 0.34, 0.022, 0.006, TILE.metal, [0, -0.04, -0.4]),
      chamferGeo(0.22, 0.16, 0.022, 0.006, TILE.metal, [0.3, 0.2, -0.4]),
      chamferGeo(0.22, 0.16, 0.022, 0.006, TILE.metal, [-0.3, 0.2, -0.4]),
    ];
    const gun = new THREE.Mesh(mergeIntoOne(metal), steel);
    const shield = new THREE.Mesh(mergeIntoOne(painted), olive);
    for (const m of [gun, shield]) { m.castShadow = m.receiveShadow = true; this.pivot.add(m); }
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.015, -1.32);
    this.pivot.add(this.muzzle);
    // a box at the tripod's middle, so the gun is something you walk into
    this.gunBox = this.world.addMover(0.32, 0.32, G.pivot);
    this.gunBox.off = true;
  }

  reset() {
    if (this.manned) this.exit(true);
    this.strike();
    this.heat = 0;
    this.hot = false;
    this.nextShot = 0;
    this.shots = 0;
    this.hint = '';
  }

  // -------------------------------------------------------------- the site

  /**
   * Put the bought kit up round a depot at (x, y, z). The gun faces the
   * way the most open street runs, the walls stand on a ring inside the
   * ring you hold, facing out, from that way round, and the wire lies
   * further out across the same approaches. A piece that would stand in
   * something, off the depot's floor, or on you, is left down.
   */
  raise(site) {
    const kit = this.game.kit;
    const w = this.world;
    this.strike();
    this.site = { x: site.x, y: site.y, z: site.z };
    this.facing = this._openest(site);
    const at = (r, a) => ({ x: site.x + Math.sin(a) * r, z: site.z + Math.cos(a) * r });
    const p = this.game.player.position;
    const level = (x, z, rad) => Math.abs(w.groundHeight(x, z, SUPPORT_RADIUS, site.y + 0.6) - site.y) < 0.15
      && !w.blocked(x, z, rad, site.y + 0.5);

    // the gun first, a little out from the depot's sign toward the street
    // it faces (so the sign's posts are behind whoever is on it): the walls
    // are laid round it
    this.gunUp = false;
    if (kit.mg) {
      for (const out of [DEPOT.gun.out, DEPOT.gun.out - 0.8, DEPOT.gun.out + 0.8, 0.8]) {
        const c = at(out, this.facing);
        if (!level(c.x, c.z, 0.45)) continue;
        this.gunAt = { x: c.x, y: site.y, z: c.z };
        this.gunRoot.position.set(c.x, site.y, c.z);
        this.gunRoot.visible = true;
        this.gunBox.off = false;
        w.placeMover(this.gunBox, c.x, c.z, 0, site.y);
        this.aimYaw = this.facing; this.aimPitch = 0;
        this._aim();
        this.gunUp = true;
        break;
      }
    }

    // A piece stands on one level, its own (a kerb is not a wall's
    // business), within a step of the depot's, clear of everything, and not
    // on you; each slot tries a little in and out and round before it gives
    // up.
    const floor = (x, z) => w.groundHeight(x, z, SUPPORT_RADIUS, site.y + 0.8);
    const fits = (c, a, half, rad, slack) => {
      const y = floor(c.x, c.z);
      if (Math.abs(y - site.y) > 0.45) return null;
      const tx = Math.cos(a), tz = -Math.sin(a);
      for (const s of [-1, -0.5, 0, 0.5, 1]) {
        const x = c.x + tx * half * s, z = c.z + tz * half * s;
        if (Math.abs(floor(x, z) - y) > slack || w.blocked(x, z, rad, y + 0.5)) return null;
      }
      return y;
    };
    const site8 = (r0, a0, half, rad, slack, clear) => {
      for (const dr of [0, -0.6, 0.6, -1.2, 1.2]) {
        for (const da of [0, 0.1, -0.1, 0.2, -0.2]) {
          const a = a0 + da, c = at(r0 + dr, a);
          if (Math.hypot(p.x - c.x, p.z - c.z) < clear) continue;
          const y = fits(c, a, half, rad, slack);
          if (y !== null) return { ...c, a, y };
        }
      }
      return null;
    };

    const wallAt = [0, 1, -1, 4, 2, -2, 3, -3];
    const wantWalls = DEPOT.walls[kit.sandbags || 0];
    for (let i = 0; i < wantWalls; i++) {
      const spot = site8(DEPOT.wallR, this.facing + wallAt[i] * Math.PI / 4, DEPOT.wallLen / 2 - 0.25, 0.3, 0.06, DEPOT.wallLen / 2 + 0.6);
      if (!spot) continue;
      const wall = this.walls[i];
      wall.mesh.position.set(spot.x, spot.y, spot.z);
      wall.mesh.rotation.y = spot.a;
      wall.mesh.visible = true;
      wall.mesh.updateMatrixWorld(true);
      wall.box.off = false;
      w.placeMover(wall.box, spot.x, spot.z, spot.a, spot.y);
      wall.up = true;
    }

    const wireAt = [0, 1, -1, 2, -2, 5];
    const wantWire = DEPOT.wires[kit.wire || 0];
    for (let i = 0; i < wantWire; i++) {
      const spot = site8(DEPOT.wireR, this.facing + wireAt[i] * 0.62, DEPOT.wireLen / 2, 0.25, 0.35, 0);
      if (!spot) continue;
      const wire = this.wires[i];
      wire.x = spot.x; wire.z = spot.z; wire.y = spot.y; wire.cos = Math.cos(spot.a); wire.sin = Math.sin(spot.a);
      wire.mesh.position.set(spot.x, spot.y, spot.z);
      wire.mesh.rotation.y = spot.a;
      wire.mesh.visible = true;
      wire.up = true;
    }

    this.meshes = this.walls.filter((x) => x.up).map((x) => x.mesh);
    const raised = { walls: this.meshes.length, wire: this.wires.filter((x) => x.up).length, gun: this.gunUp };
    this.raised = raised;
    return raised;
  }

  /** Everything back down, and whoever was on the gun off it. */
  strike() {
    if (this.manned) this.exit(true);
    for (const wl of this.walls) { wl.up = false; wl.mesh.visible = false; wl.box.off = true; }
    for (const wr of this.wires) { wr.up = false; wr.mesh.visible = false; }
    if (this.gunRoot) this.gunRoot.visible = false;
    if (this.gunBox) this.gunBox.off = true;
    this.gunUp = false;
    this.meshes = [];
    this.site = null;
  }

  /**
   * Which way the most street runs from the depot: sixteen bearings, each
   * as far as a sight line at chest height reaches out to 40 m, smoothed
   * with its neighbours so one alley does not win over an avenue.
   */
  _openest(site) {
    const w = this.world, n = 16, reach = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      let d = 4;
      while (d < 40 && w.lineOfSight(site.x, site.y + 1.3, site.z,
        site.x + Math.sin(a) * (d + 4), site.y + 1.3, site.z + Math.cos(a) * (d + 4))) d += 4;
      reach.push(d);
    }
    let best = 0, bestScore = -1;
    for (let i = 0; i < n; i++) {
      const s = reach[i] * 2 + reach[(i + 1) % n] + reach[(i + n - 1) % n];
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return (best / n) * Math.PI * 2;
  }

  // ----------------------------------------------------------------- wire

  /** Every hostile in a coil is held up and cut; a kill it makes is yours. */
  snare(dt, time) {
    if (!this.site) return;
    const W = DEPOT.wire, g = this.game;
    for (const e of g.enemies) {
      if (!e.alive || e.type.friendly) continue;
      let caught = null;
      for (const wr of this.wires) {
        if (!wr.up || Math.abs(e.pos.y - wr.y) > 0.9) continue;
        const rx = e.pos.x - wr.x, rz = e.pos.z - wr.z;
        const lx = wr.cos * rx - wr.sin * rz, lz = wr.sin * rx + wr.cos * rz;
        if (Math.abs(lx) < DEPOT.wireLen / 2 + 0.2 && Math.abs(lz) < DEPOT.wireRad + 0.25) { caught = wr; break; }
      }
      if (!caught) continue;
      e.snaredUntil = time + 0.15;
      e.wireCut = (e.wireCut || 0) + W.dps * dt;
      if (e.wireCut >= W.dps * W.tick) {
        _down.set(e.pos.x - caught.x, 0.001, e.pos.z - caught.z).normalize();
        _knee.set(e.pos.x, e.pos.y + 0.45, e.pos.z);
        const result = e.damage(e.wireCut, 'limb', _down, _knee);
        e.wireCut = 0;
        if (result === 'kill') g.registerHit(e, result, 'WIRE', false);
      }
    }
  }

  // ------------------------------------------------------------------ gun

  get manned() { return !!this.gunner; }

  inReach(player) {
    if (!this.gunUp || player.dead || player.mantle || player.vehicle) return false;
    if (Math.abs(player.feetY - this.gunAt.y) > 0.8) return false;
    return Math.hypot(player.position.x - this.gunAt.x, player.position.z - this.gunAt.z) < DEPOT.gun.reach;
  }

  /** Behind the gun: the body held, your own weapon away, the view on its sight. */
  enter(player) {
    if (!this.inReach(player)) return false;
    this.gunner = player;
    player.vehicle = this;
    player.velocity.set(0, 0, 0);
    player.slide = null;
    player.lean = 0;
    player.leanOffset.set(0, 0, 0);
    player.crouching = player.sprinting = false;
    player.yaw = this.facing + Math.PI;     // the camera looks down -z of its yaw
    player.pitch = 0;
    this.game.weapons.adsT = 0;
    audio.door(V.set(this.gunAt.x, this.gunAt.y + 1, this.gunAt.z), false);
    return true;
  }

  /** Off the gun, a step behind it, or wherever there is room. */
  exit(force = false) {
    const p = this.gunner;
    if (!p) return false;
    const back = this.aimYaw + Math.PI;
    const G = DEPOT.gun;
    for (const [r, da] of [[1.3, 0], [1.3, 0.8], [1.3, -0.8], [1.3, 1.6], [1.3, -1.6]]) {
      const x = this.gunAt.x + Math.sin(back + da) * r, z = this.gunAt.z + Math.cos(back + da) * r;
      if (!force && this.world.blocked(x, z, p.radius, this.gunAt.y + 0.6)) continue;
      this._stand(p, x, z);
      return true;
    }
    if (!force) { this.game.hud.toast('NO ROOM TO GET OFF'); return false; }
    this._stand(p, this.gunAt.x + Math.sin(back) * G.back, this.gunAt.z + Math.cos(back) * G.back);
    return true;
  }

  _stand(p, x, z) {
    p.vehicle = null;
    this.gunner = null;
    const h = this.world.groundHeight(x, z, SUPPORT_RADIUS, this.gunAt.y + 0.6);
    p.feetY = h;
    p.fallTop = h;
    p.eyeHeight = 1.68;
    p.position.set(x, h + p.eyeHeight, z);
    p.velocity.set(0, 0, 0);
    p.onGround = true;
    p.pitch = THREE.MathUtils.clamp(p.pitch, -0.6, 0.4);
  }

  /** Nothing of a hit lands on the gun itself; the shield is `shelterFrom`. */
  damage() {}

  /** Of a hit from `from`, the share that reaches you behind the gun. */
  shelterFrom(from) {
    if (!from) return 1;
    const a = Math.atan2(from.x - this.gunAt.x, from.z - this.gunAt.z);
    return Math.abs(wrap(a - this.aimYaw)) < DEPOT.gun.front ? DEPOT.gun.shelter : 1;
  }

  _aim() {
    this.pivot.rotation.set(this.aimPitch, this.aimYaw + Math.PI, 0);
    this.gunRoot.updateMatrixWorld(true);
  }

  /** The gunner's view and the gun on it, the barrel's heat, and the trigger. */
  update(dt, time, input) {
    const G = DEPOT.gun;
    this.heat = Math.max(0, this.heat - G.cool * dt);
    if (this.hot && this.heat < G.recover) this.hot = false;
    const p = this.gunner;
    this.hint = '';
    if (!p) {
      if (this.inReach(this.game.player) && !this.game.truck?.inReach(this.game.player)) this.hint = '[E] MAN THE GUN';
      return;
    }
    if (p.dead) { p.vehicle = null; this.gunner = null; return; }

    // the traverse: the mouse turns the view, the view turns the gun, and
    // the gun stops at the ends of its arc
    const rel = wrap(p.yaw + Math.PI - this.facing);
    const clamped = THREE.MathUtils.clamp(rel, -G.traverse, G.traverse);
    p.yaw = this.facing + clamped - Math.PI;
    p.pitch = THREE.MathUtils.clamp(p.pitch, G.pitchMin, G.pitchMax);
    this.aimYaw = this.facing + clamped;
    this.aimPitch = p.pitch;
    this._aim();

    const fx = Math.sin(this.aimYaw), fz = Math.cos(this.aimYaw);
    p.feetY = this.gunAt.y;
    p.fallTop = p.feetY;
    p.position.set(this.gunAt.x - fx * G.back, this.gunAt.y + G.pivot + G.up, this.gunAt.z - fz * G.back);
    p.velocity.set(0, 0, 0);
    p.onGround = true;
    p.shake = Math.max(0, p.shake - dt * 1.6);
    const cam = p.camera;
    cam.position.copy(p.position);
    cam.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    cam.updateMatrixWorld();

    this.hint = this.hot ? 'BARREL OVERHEATED — LET IT COOL' : `[E] OFF THE GUN · BARREL ${Math.round(this.heat * 100)}%`;
    if (!input.fire || this.hot || time < this.nextShot || this.game.state !== 'playing') return;
    this.nextShot = time + G.rate;
    this.shots++;
    this.heat = Math.min(1, this.heat + G.heat);
    if (this.heat >= 1) { this.hot = true; audio.hiss(this.muzzle.getWorldPosition(V)); }

    cam.getWorldDirection(D);
    const sx = (hash(this.shots) - 0.5) * 2 * G.spread, sy = (hash(this.shots + 0.5) - 0.5) * 2 * G.spread;
    D.x += sx; D.y += sy; D.normalize();
    this.muzzle.getWorldPosition(V);
    this.game.hitscan(D.clone(), GUN_DEF, V.clone());
    this.game.effects.muzzle(V, 1.3);
    audio.shot('mg');
    this.game.alertNearby(55);
    this.game.night?.fired(time);
    p.addShake(0.035);
    p.pitch += 0.004;
  }
}
