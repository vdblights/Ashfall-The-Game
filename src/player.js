import * as THREE from 'three';
import { SUPPORT_RADIUS } from './world.js';

/** Keyboard + mouse state, including pointer-lock look deltas. */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.fire = false;
    this.aim = false;
    this.lookDelta = new THREE.Vector2();
    this.wheel = 0;
    this.locked = false;
    this.fallback = false;      // pointer lock refused: steer without capture
    this.pointerInside = false;
    this.steer = new THREE.Vector2();   // -1..1 offset from screen centre
    this.sensitivity = 1;
    this.invertY = false;
    this.onKey = null;
    this.onKeyUp = null;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (this.onKey) this.onKey(e.code, e);
      if (['Space', 'Tab', 'ControlLeft', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (this.onKeyUp) this.onKeyUp(e.code, e);
    });
    addEventListener('blur', () => { this.keys.clear(); this.fire = false; this.aim = false; });

    canvas.addEventListener('mouseenter', () => { this.pointerInside = true; });
    canvas.addEventListener('mouseleave', () => {
      // stop turning rather than freezing mid-swing when the cursor leaves
      this.pointerInside = false;
      this.steer.set(0, 0);
      this.fire = false;
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked && !this.fallback) return;
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.aim = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.aim = false;
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (this.locked) {
        this.lookDelta.x += e.movementX * 0.0022 * this.sensitivity;
        this.lookDelta.y += e.movementY * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1);
        return;
      }
      if (!this.fallback) return;
      // Without capture, movement deltas die at the window edge — the cursor
      // simply stops. Steer by where the cursor sits instead: offset from the
      // centre becomes a turn rate, which keeps working at the very edge and
      // survives the pointer leaving entirely.
      const r = canvas.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      const dead = 0.12;
      const shape = (v) => {
        const a = Math.abs(v);
        if (a < dead) return 0;
        // ease in past the dead zone so small movements stay controllable
        const t = (a - dead) / (1 - dead);
        return Math.sign(v) * t * t;
      };
      this.steer.set(shape(nx), shape(ny) * (this.invertY ? -1 : 1));
      this.pointerInside = nx > -1 && nx < 1 && ny > -1 && ny < 1;
    });
    addEventListener('wheel', (e) => {
      if (this.locked || this.fallback) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) {
        // real capture beats steering: drop back out of the fallback
        this.fallback = false;
        this.steer.set(0, 0);
      } else {
        this.fire = false; this.aim = false; this.keys.clear();
      }
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  /**
   * Ask for pointer lock, and fall back to unlocked mouse-look if it is
   * refused — embedded frames and some browsers deny it, and the game still
   * has to be playable there.
   */
  requestLock() {
    if (!this.canvas.requestPointerLock) { this.enableFallback(); return; }
    // always worth another try: a denial can be temporary (Chrome rate-limits
    // re-locking after Esc), and succeeding later should restore real capture
    try {
      const res = this.canvas.requestPointerLock();
      if (res && typeof res.catch === 'function') res.catch(() => this.enableFallback());
    } catch {
      this.enableFallback();
    }
    clearTimeout(this._lockTimer);
    this._lockTimer = setTimeout(() => { if (!this.locked) this.enableFallback(); }, 700);
  }

  enableFallback() {
    if (this.fallback) return;
    this.fallback = true;
    if (this.onFallback) this.onFallback();
  }
  exitLock() { document.exitPointerLock?.(); }
  down(code) { return this.keys.has(code); }
  endFrame() { this.lookDelta.set(0, 0); this.wheel = 0; }
}

const TARGET = new THREE.Vector3();
const EYE_STAND = 1.68;
const EYE_CROUCH = 1.05;
const GRAVITY = 22;
const STEP_HEIGHT = 0.55;      // how high you can walk up without jumping
const BODY_HEIGHT = 1.85;      // feet to the crown, for ceilings
// A fall is judged by the height it was dropped from — the highest the feet
// were since they left the ground, so a jump off a roof counts its apex too.
// Not by the speed it lands at: the step integrates a fall a frame ahead of
// the curve, so a 9 m drop landed at the speed of 7.6 m.
// Under FALL.safe it costs nothing: a car roof, a crate, a jump off a shop's
// counter. Past it the bill climbs faster than the height (`curve`), so
// stepping off a container stack stings and a three-storey roof leaves you
// on your last legs; from FALL.lethal it is a full health bar, which is
// every stair roof of four storeys and up (they reach 14 m).
/** The share of a hit an armour plate takes out of itself rather than you. */
export const ARMOUR_SOAK = 0.6;

export const FALL = { safe: 3.5, lethal: 11, curve: 1.5 };
/** What a drop of `h` metres costs, out of a 100-point health bar. */
export function fallDamage(h) {
  if (h <= FALL.safe) return 0;
  const k = Math.min(1, (h - FALL.safe) / (FALL.lethal - FALL.safe));
  return k >= 1 ? 100 : Math.round(100 * Math.pow(k, FALL.curve));
}
const MANTLE_HEIGHT = 1.8;     // highest ledge you can haul yourself onto
const WIND_BACK = 0.33;        // stamina back before a winded sprint picks up again
// A pull-up runs at a roughly constant climb rate rather than a fixed
// duration: one fixed duration means a 0.6 m kerb and a 1.8 m wall move the
// camera at three times the speed of each other, and the tall one reads as
// being fired upwards.
const MANTLE_BASE = 0.32;      // seconds of reach-and-settle, whatever the height
const MANTLE_PER_M = 0.22;     // plus this per metre climbed

/**
 * Smoothstep leaves acceleration discontinuous at both ends: the camera
 * starts and stops moving smoothly but *changes* speed instantly, which is
 * exactly the jolt you feel at the top of a climb. The quintic is zero in
 * both derivatives at 0 and 1.
 */
/**
 * A slide: crouch out of a sprint and you go down on one hip and keep going.
 * `min` is the speed it takes to start one, `boost` what it starts at over
 * the speed you had, `end` what it bleeds down to over `dur` (and `fall`
 * how it bleeds: over one, most of the speed goes early), `eye` how low
 * the view goes, `rest` how long before the next.
 */
export const SLIDE = { min: 6.4, boost: 1.35, end: 4.2, fall: 1.3, dur: 0.9, eye: 0.82, rest: 0.55, stamina: 0.1 };
/**
 * A lean: hold Q or E and the head goes out past the corner while the feet
 * stay behind it. `hold` is how long a key is held before it leans, so a tap
 * still cycles a weapon or works a door; `side` how far the head goes, `dip`
 * how far it drops, `roll` the tilt of the view, `slow` the walking speed
 * lost at full lean.
 */
export const LEAN = { hold: 0.16, side: 0.48, dip: 0.07, roll: 0.12, slow: 0.45, margin: 0.14 };

const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
/** A 0 → 1 → 0 hump with no corner at the peak. */
const hump = (t) => Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.position = new THREE.Vector3(0, EYE_STAND, 0);   // eye position
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.radius = 0.42;
    this.leanOffset = new THREE.Vector3();
    this._head = new THREE.Vector3();
    this.reset(0, 0);
  }

  /**
   * Where the head is: the eye, plus a lean. What a hostile looks for and
   * shoots at, because leaning round a corner puts the head out where the
   * body is not, and a body hidden behind it must not hide the head.
   */
  get head() { return this._head.copy(this.position).add(this.leanOffset); }

  reset(x, z) {
    // on whatever floor is underfoot: most of the sector is pavement, and the
    // plaza you start in is a slab, not the street
    this.feetY = this.world.groundHeight(x, z, SUPPORT_RADIUS, STEP_HEIGHT);
    this.position.set(x, this.feetY + EYE_STAND, z);
    this.fallTop = this.feetY;
    this.velocity.set(0, 0, 0);
    this.eyeHeight = EYE_STAND;
    this.onGround = true;
    this.crouching = false;
    this.sprinting = false;
    this.health = 100;
    this.maxHealth = 100;
    this.armour = 0;                // a plate found in a building, worn down by hits
    this.maxArmour = 100;
    this.stamina = 1;
    this.winded = false;
    this.lastDamageTime = -99;
    this.bobPhase = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.dead = false;
    this.stepTimer = 0;
    this.shake = 0;
    this.mantle = null;
    this.climbLean = 0;
    this.slide = null;
    this.slideRest = 0;
    this.slides = 0;
    this.crouchHeld = false;
    this.lean = 0;
    this.leanReach = 1;
    this.leanHeld = { KeyQ: 0, KeyE: 0 };
    this.leanOffset.set(0, 0, 0);
  }

  applyRecoil(v, h) {
    this.recoilPitch += v;
    this.recoilYaw += h;
  }

  /** Camera trauma, 0..1 — squared on use so small knocks stay subtle. */
  addShake(amount) {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** @param {number} time game clock, so regeneration measures the same units */
  damage(amount, time) {
    if (this.dead) return false;
    this.health -= amount;
    this.lastDamageTime = time;
    if (this.health <= 0) { this.health = 0; this.dead = true; return true; }
    return false;
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /**
   * What a hit leaves after the plate has taken its share: `ARMOUR_SOAK` of
   * it, out of the plate, until the plate is gone.
   */
  soak(amount) {
    const taken = Math.min(this.armour, amount * ARMOUR_SOAK);
    this.armour -= taken;
    return amount - taken;
  }

  update(dt, time, input) {
    // ---- look ----------------------------------------------------------
    const turn = 2.2 * dt;
    if (input.down('ArrowLeft')) this.yaw += turn;
    if (input.down('ArrowRight')) this.yaw -= turn;
    if (input.down('ArrowUp')) this.pitch += turn * 0.7;
    if (input.down('ArrowDown')) this.pitch -= turn * 0.7;

    // uncaptured mouse: cursor offset from centre drives a turn rate
    if (input.fallback && input.pointerInside) {
      const rate = 3.1 * dt * input.sensitivity;
      this.yaw -= input.steer.x * rate;
      this.pitch -= input.steer.y * rate * 0.75;
    }

    this.yaw -= input.lookDelta.x;
    this.pitch -= input.lookDelta.y;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

    // recoil decays back toward the original point of aim
    this.recoilPitch = THREE.MathUtils.damp(this.recoilPitch, 0, 6, dt);
    this.recoilYaw = THREE.MathUtils.damp(this.recoilYaw, 0, 6, dt);

    if (this.dead) {
      this.lean = 0;
      this.leanOffset.set(0, 0, 0);
      this.slide = null;
      this.eyeHeight = THREE.MathUtils.damp(this.eyeHeight, 0.35, 4, dt);
      this.position.y = this.feetY + this.eyeHeight;
      this.camera.position.copy(this.position);
      this.camera.rotation.set(this.pitch * 0.4, this.yaw, 0.55, 'YXZ');
      return;
    }

    // A pull-up already in flight runs to completion before anything else.
    if (this.mantle) {
      this._advanceMantle(dt);
      this._applyCamera(dt, 0);
      return;
    }

    // ---- intent --------------------------------------------------------
    let ix = 0, iz = 0;
    if (input.down('KeyW')) iz -= 1;
    if (input.down('KeyS')) iz += 1;
    if (input.down('KeyA')) ix -= 1;
    if (input.down('KeyD')) ix += 1;
    const moving = ix !== 0 || iz !== 0;

    const crouchKey = input.down('ControlLeft') || input.down('ControlRight') || input.down('KeyC');
    const crouchPressed = crouchKey && !this.crouchHeld;
    this.crouchHeld = crouchKey;
    this.slideRest = Math.max(0, this.slideRest - dt);
    // Crouch out of a sprint and you slide, on what you were already doing:
    // the sprint is last frame's, so the slide starts at the speed it had.
    const was = Math.hypot(this.velocity.x, this.velocity.z);
    if (!this.slide && crouchPressed && this.sprinting && this.onGround && was > SLIDE.min
        && this.slideRest <= 0 && this.stamina > SLIDE.stamina) {
      this.slide = { t: 0, dx: this.velocity.x / was, dz: this.velocity.z / was, v0: was * SLIDE.boost };
      this.slides++;
      this.stamina -= SLIDE.stamina;
      if (this.onSlide) this.onSlide();
    }
    this.crouching = crouchKey || !!this.slide;

    // A lean waits for its key to be held, so a tap is still a tap: Q cycles
    // the weapon and E works a door, on release (`Game.bindUI`).
    for (const k in this.leanHeld) this.leanHeld[k] = input.down(k) ? this.leanHeld[k] + dt : 0;
    const leanWant = (this.leanHeld.KeyE >= LEAN.hold ? 1 : 0) - (this.leanHeld.KeyQ >= LEAN.hold ? 1 : 0);
    const canLean = !this.slide && !this.sprinting && this.onGround;
    this.lean = THREE.MathUtils.damp(this.lean, canLean ? leanWant : 0, 10, dt);
    if (Math.abs(this.lean) < 1e-3) this.lean = 0;

    // firing or aiming drops you out of a sprint
    const wantSprint = (input.down('ShiftLeft') || input.down('ShiftRight'))
      && iz < 0 && !this.crouching && !input.aim && !input.fire;
    // Run out and you are winded until a third of it is back. Sprint used to
    // turn off at empty and on again a frame later, every frame, with the
    // key held: the gun swapped between its sprint and run poses sixty times
    // a second, reported from play as the gun shaking in your hands.
    if (this.stamina <= 0.02) this.winded = true;
    else if (this.stamina >= WIND_BACK) this.winded = false;
    this.sprinting = wantSprint && !this.winded;

    if (this.sprinting && moving) this.stamina = Math.max(0, this.stamina - dt * 0.28);
    else this.stamina = Math.min(1, this.stamina + dt * (moving ? 0.16 : 0.32));

    let speed = 5.2;
    if (this.sprinting) speed = 8.2;
    if (this.crouching) speed = 2.6;
    if (input.aim && !this.sprinting) speed *= 0.55;
    if (!this.onGround) speed *= 0.92;
    speed *= 1 - LEAN.slow * Math.abs(this.lean);

    // ---- horizontal movement -------------------------------------------
    // camera forward is (-sin yaw, -cos yaw); right is (cos yaw, -sin yaw)
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = 0, wz = 0;
    if (moving) {
      const len = Math.hypot(ix, iz);
      const nx = ix / len, nz = iz / len;
      wx = sin * nz + cos * nx;
      wz = cos * nz - sin * nx;
    }
    const target = TARGET.set(wx * speed, 0, wz * speed);
    const accel = this.onGround ? 14 : 3.5;
    if (this.slide) {
      // the way it started, bleeding speed off: no steering on a hip
      const s = this.slide;
      s.t += dt;
      const k = Math.min(1, s.t / SLIDE.dur);
      const v = SLIDE.end + (s.v0 - SLIDE.end) * Math.pow(1 - k, SLIDE.fall);
      this.velocity.x = s.dx * v;
      this.velocity.z = s.dz * v;
    } else {
      this.velocity.x = THREE.MathUtils.damp(this.velocity.x, target.x, accel, dt);
      this.velocity.z = THREE.MathUtils.damp(this.velocity.z, target.z, accel, dt);
    }

    // ---- mantle ----------------------------------------------------------
    // Jump into a waist-to-chest ledge and you climb it instead of bouncing
    // off it. Direction of travel if you are moving, where you are looking if
    // you are standing still — so a car roof is one keypress either way.
    if (input.down('Space')
        && this.tryMantle(moving ? wx : -sin, moving ? wz : -cos)) {
      this._advanceMantle(dt);
      this._applyCamera(dt, 0);
      return;
    }

    // ---- jump / gravity -------------------------------------------------
    if (input.down('Space') && this.onGround) {
      this.velocity.y = 7.4;
      this.onGround = false;
    }
    this.velocity.y -= GRAVITY * dt;
    const before = this.feetY;
    this.feetY += this.velocity.y * dt;
    // a jump indoors stops against the ceiling instead of passing into it
    const over = this.world.ceilingAbove(this.position.x, this.position.z, this.radius * 0.5, this.feetY + 0.5);
    if (this.feetY + BODY_HEIGHT > over) {
      this.feetY = over - BODY_HEIGHT;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }

    // Move horizontally first. Anything no taller than a step above the feet
    // is walkable, so it does not block — the support check below lifts you.
    const px = this.position.x, pz = this.position.z;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.world.resolve(this.position, this.radius, this.feetY, STEP_HEIGHT, BODY_HEIGHT);
    this.world.clampToBounds(this.position, this.radius);
    // A slide into something stops at it, with the speed it has left: the
    // velocity a slide sets is not damped, so without this it would keep
    // shoving into a wall for the rest of its duration.
    if (this.slide) {
      const moved = Math.hypot(this.position.x - px, this.position.z - pz);
      const meant = Math.hypot(this.velocity.x, this.velocity.z) * dt;
      if (this.slide.t > 0.05 && moved < meant * 0.4) {
        this.velocity.x = (this.position.x - px) / dt;
        this.velocity.z = (this.position.z - pz) / dt;
        this._endSlide();
      }
    }

    // ---- footing ---------------------------------------------------------
    // Footing asks how much floor is under the feet, not how wide the body
    // is: supporting the player anywhere their whole cylinder clipped a
    // surface left them standing 0.42 m out past every roof edge, bridged
    // every gap narrower than two radii, and stepped them up onto a kerb
    // before they had reached it.
    // In the air, anything the feet passed through this frame: a landing
    // asked only at where the fall ended goes straight through whatever it
    // crossed on the way. On the street that was a frame's dip under the kerb
    // before the step-up caught it; on a roof it was the street.
    this.fallTop = this.onGround ? before : Math.max(this.fallTop, before);
    const ceiling = this.onGround ? this.feetY + STEP_HEIGHT : Math.max(this.feetY, before) + 0.02;
    const support = this.world.groundHeight(this.position.x, this.position.z, SUPPORT_RADIUS, ceiling);
    if (this.feetY <= support + 1e-4) {
      if (!this.onGround && this.onFallDamage) {
        const hurt = fallDamage(this.fallTop - support);
        if (hurt > 0) this.onFallDamage(hurt);
      }
      // Walking up a step moves the feet onto it at once, which is right, and
      // used to move the view with them, which is not: every kerb in the city
      // was a 28 cm jolt between two frames. The rise is taken out of the eye
      // height instead, and the damp below hands it back over a few frames,
      // the same way it eases a crouch. Below 5 cm is the frame's own gravity
      // dip being caught, not a step.
      const rise = support - this.feetY;
      if (this.onGround && rise > 0.05) this.eyeHeight -= rise;
      this.feetY = support;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      // walked off an edge
      this.onGround = false;
    }
    // a slide ends in the air (a jump out of it keeps the speed), or when it
    // has run its length
    if (this.slide && (!this.onGround || this.slide.t >= SLIDE.dur)) this._endSlide();

    // ---- view height, bob ----------------------------------------------
    const wantEye = this.slide ? SLIDE.eye : this.crouching ? EYE_CROUCH : EYE_STAND;
    this.eyeHeight = THREE.MathUtils.damp(this.eyeHeight, wantEye, this.slide ? 10 : 12, dt);
    this.slideTilt = THREE.MathUtils.damp(this.slideTilt || 0, this.slide ? 1 : 0, 10, dt);

    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.bobPhase += dt * (hSpeed * 1.6 + 1);
    const bob = this.onGround && !this.slide ? Math.sin(this.bobPhase * 2) * 0.022 * Math.min(hSpeed / 6, 1) : 0;
    const roll = Math.sin(this.bobPhase) * 0.006 * Math.min(hSpeed / 6, 1) + this.slideTilt * 0.05;

    this.position.y = this.feetY + this.eyeHeight + bob;
    this._placeLean(dt);

    // footsteps, which a slide has none of
    if (this.onGround && hSpeed > 1.5 && !this.slide) {
      this.stepTimer -= dt * hSpeed;
      if (this.stepTimer <= 0) {
        this.stepTimer = 4.2;
        if (this.onStep) this.onStep();
      }
    }

    // ---- health regeneration -------------------------------------------
    if (time - this.lastDamageTime > 5 && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + dt * 9);
    }

    this._applyCamera(dt, roll);
  }

  _applyCamera(dt, roll) {
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const trauma = this.shake * this.shake;
    const sx = trauma * (Math.random() - 0.5) * 0.09;
    const sy = trauma * (Math.random() - 0.5) * 0.09;
    const sr = trauma * (Math.random() - 0.5) * 0.07;

    // A climb dips the head and leans into the ledge. Without it a pull-up is
    // a camera being translated, which is the part that reads as a lift
    // rather than a haul. It rides a hump, so it is back at zero by the time
    // the climb hands control back.
    const lean = this.climbLean;

    this.camera.position.copy(this.position).add(this.leanOffset);
    this.camera.position.y += trauma * (Math.random() - 0.5) * 0.06;
    this.camera.rotation.set(
      this.pitch + this.recoilPitch + sy - lean * 0.1,
      this.yaw + this.recoilYaw + sx,
      roll + sr + lean * 0.06 - this.lean * this.leanReach * LEAN.roll, 'YXZ');
  }

  _endSlide() {
    this.slide = null;
    this.slideRest = SLIDE.rest;
  }

  /**
   * Put the head out to the side the lean asks for, as far as it goes before
   * it meets something. The way out is traced from the eye, so a lean
   * against a wall goes nowhere and a lean at a corner stops at the corner's
   * far side less a margin — the head is never inside a wall, and never past
   * one. It is pulled in at once and let out smoothly, so turning into a
   * wall does not push the view through it for a frame.
   */
  _placeLean(dt) {
    const L = this.lean;
    if (L === 0) { this.leanOffset.set(0, 0, 0); this.leanReach = 1; return; }
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const side = L * LEAN.side, s = Math.sign(L), p = this.position;
    const dip = LEAN.dip * L * L;
    const clear = (k) => this.world.lineOfSight(p.x, p.y, p.z,
      p.x + rx * (side * k + s * LEAN.margin), p.y - dip * k, p.z + rz * (side * k + s * LEAN.margin));
    let f = 1;
    if (!clear(1)) {
      let lo = 0, hi = 1;
      if (!clear(0)) hi = 0;
      for (let i = 0; i < 6 && hi > 0; i++) {
        const mid = (lo + hi) / 2;
        if (clear(mid)) lo = mid; else hi = mid;
      }
      f = lo;
    }
    this.leanReach = f < this.leanReach ? f : THREE.MathUtils.damp(this.leanReach, f, 12, dt);
    const k = this.leanReach;
    this.leanOffset.set(rx * side * k, -dip * k, rz * side * k);
  }

  /**
   * Advance a pull-up. It owns the player's position for its duration — no
   * gravity, no collision, no walking — so it cannot be interrupted halfway
   * and leave you inside the ledge you were climbing.
   */
  _advanceMantle(dt) {
    const m = this.mantle;
    m.t = Math.min(1, m.t + dt / m.dur);
    // hands go up first, feet swing over after: rising leads the reach
    const rise = smoother(Math.min(1, m.t / 0.75));
    const reach = smoother(Math.max(0, (m.t - 0.3) / 0.7));
    // The lip you grip and the deck you land on are not always the same
    // height — `mantleTarget` allows a quarter-metre of drop past the edge.
    // Clearing the lip and then settling onto the deck is the difference
    // between stepping down and falling the moment the climb hands back.
    const settle = smoother(Math.max(0, (m.t - 0.72) / 0.28));
    this.feetY = m.fromY + (m.top - m.fromY) * rise - (m.top - m.land) * settle;
    this.position.x = m.fromX + (m.x - m.fromX) * reach;
    this.position.z = m.fromZ + (m.z - m.fromZ) * reach;

    // Ducked through the climb — but from the eye height you actually had,
    // not from a crouch. Snapping straight to `EYE_CROUCH` on the first frame
    // dropped the camera 0.63 m between one frame and the next, which is the
    // single biggest thing a pull-up used to do to the view.
    const lean = hump(m.t);
    this.climbLean = lean;
    this.eyeHeight = m.fromEye + (EYE_STAND - m.fromEye) * smoother(m.t) - lean * 0.26;

    if (m.t >= 1) {
      this.mantle = null;
      this.onGround = true;
      // Walk out of it rather than stopping dead on top. Zeroing the velocity
      // handed control back at a standstill, so every climb ended in the same
      // quarter-second of re-acceleration.
      this.velocity.set(m.dirX * 2.6, 0, m.dirZ * 2.6);
    }
    this.position.y = this.feetY + this.eyeHeight;
  }

  /**
   * Start a pull-up if there is a ledge to grab in the given direction.
   * @returns {boolean} whether one started
   */
  tryMantle(dirX, dirZ) {
    if (this.mantle || this.dead || this.crouching || this.stamina < 0.12) return false;
    const ledge = this.world.mantleTarget(
      this.position.x, this.position.z, this.radius, this.feetY,
      dirX, dirZ, STEP_HEIGHT + 0.05, MANTLE_HEIGHT);
    if (!ledge) return false;

    const climb = Math.max(0, ledge.top - this.feetY);
    const dx = ledge.x - this.position.x, dz = ledge.z - this.position.z;
    const len = Math.hypot(dx, dz) || 1;
    this.mantle = {
      t: 0,
      dur: MANTLE_BASE + climb * MANTLE_PER_M,
      fromX: this.position.x, fromZ: this.position.z, fromY: this.feetY,
      fromEye: this.eyeHeight,
      dirX: dx / len, dirZ: dz / len,
      x: ledge.x, z: ledge.z, top: ledge.top, land: ledge.land,
    };
    this.stamina = Math.max(0, this.stamina - 0.12);
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    // both hands on the ledge: nothing leans through a climb
    this.lean = 0;
    this.leanOffset.set(0, 0, 0);
    if (this.onMantle) this.onMantle();
    return true;
  }
}
