import * as THREE from 'three';
import { SUN_DIR } from './atmosphere.js';
import { reserve } from './rng.js';

/**
 * Two shadow cascades for the one sun.
 *
 * A single shadow map has to choose between reach and sharpness. Spread over
 * the hundred metres the city needs, 2048 texels is five centimetres apiece
 * across the light — and with the sun 24 degrees up, the map lies on the
 * ground stretched by 1/sin(24°), so along the sun's bearing it is thirteen.
 * That is the smear under every barrier and the stair-stepped edge on every
 * shadow near the player, which are exactly the shadows a player looks at.
 *
 * So there are two maps. The sun keeps the wide one. A second directional
 * light at the same angle, with zero intensity — it lights nothing — renders
 * a tight map around the patch of street in front of the player, at about a
 * centimetre a texel. The sun's shadow lookup is rewritten to read the tight
 * map wherever it covers and the wide one everywhere else, blended across the
 * last stretch of the tight map so the seam never shows.
 *
 * Both are snapped to whole texels in the light's own frame. A shadow box
 * that slides continuously with the player re-rasterises every edge at a
 * sub-texel offset each frame, which reads as shadows crawling along walls
 * as you walk; snapped, an edge only ever moves when the thing casting it does.
 */

/** How far the shadow-casting lights sit from the ground they light. */
export const SUN_DISTANCE = 77;

// The light's frame. three aims a shadow camera with lookAt and +Y up, so its
// axes are these, and snapping in them is snapping in shadow-map texels.
const Z = SUN_DIR.clone();
const X = new THREE.Vector3(0, 1, 0).cross(Z).normalize();
const Y = Z.clone().cross(X);
const P = new THREE.Vector3();

/**
 * Centre a directional light's shadow box on `center`, snapped to the texel
 * grid of a map `span` metres either side and `size` texels across.
 */
export function placeShadow(light, center, span, size) {
  const texel = (span * 2) / size;
  const a = Math.round(center.dot(X) / texel) * texel;
  const b = Math.round(center.dot(Y) / texel) * texel;
  const c = center.dot(Z);
  P.copy(X).multiplyScalar(a).addScaledVector(Y, b).addScaledVector(Z, c);
  light.target.position.copy(P);
  light.position.copy(P).addScaledVector(SUN_DIR, SUN_DISTANCE);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();
}

/** Set a light's shadow box to `span` metres either side and `size` texels. */
export function sizeShadow(light, span, size) {
  const s = light.shadow;
  if (s.mapSize.x !== size) {
    s.mapSize.set(size, size);
    s.map?.dispose();
    s.map = null;                 // three rebuilds it at the new size
  }
  const c = s.camera;
  c.left = -span; c.right = span; c.top = span; c.bottom = -span;
  c.updateProjectionMatrix();
}

let installed = null;

/**
 * Rewrite the directional-light loop so light 0 — the sun — reads the tight
 * map (shadow 1) where it covers and the wide one (shadow 0) elsewhere.
 *
 * Shadow-casting lights are sorted first and keep scene order among
 * themselves, so this only holds while the sun is the first shadow-casting
 * directional light in the scene and the cascade the second. With one
 * shadowed light — the cascade switched off, or a tier without it — the
 * original lookup is what compiles.
 *
 * @returns {boolean} whether the cascade is in the shader; false only if a
 *          three upgrade has moved the line it replaces
 */
export function installShadowCascade() {
  if (installed !== null) return installed;
  installed = false;
  const C = THREE.ShaderChunk;
  const original = /* glsl */`		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;`;
  if (!C.lights_fragment_begin.includes(original)) {
    // a three upgrade moved the line; better no cascade than a broken shader
    console.warn('shadow cascade: three\'s light loop has changed, cascade not installed');
    return false;
  }
  const cascaded = /* glsl */`
		#if ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 0 )
		{
			// the sun: tight map where it covers, wide map beyond, blended over
			// the outer tenth of the tight one so its edge never shows
			vec4 nc = vDirectionalShadowCoord[ 1 ];
			vec3 np = nc.xyz / nc.w;
			vec2 inset = min( np.xy, 1.0 - np.xy );
			float nearW = ( np.z <= 1.0 ) ? smoothstep( 0.0, 0.1, min( inset.x, inset.y ) ) : 0.0;
			float s = 1.0;
			if ( directLight.visible && receiveShadow ) {
				DirectionalLightShadow ns = directionalLightShadows[ 1 ];
				float nearS = nearW > 0.0
					? getShadow( directionalShadowMap[ 1 ], ns.shadowMapSize, ns.shadowIntensity, ns.shadowBias, ns.shadowRadius, nc )
					: 1.0;
				float farS = nearW < 1.0
					? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )
					: 1.0;
				s = mix( farS, nearS, nearW );
			}
			directLight.color *= s;
		}
		#elif ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 1 )
			// the cascade light itself: zero intensity, nothing to shadow
		#else
${original}
		#endif`;
  C.lights_fragment_begin = C.lights_fragment_begin.replace(original, cascaded);
  installed = true;
  return true;
}

/**
 * The city's shadow, drawn once and copied in every frame.
 *
 * Every frame used to draw the whole city into the wide shadow map again —
 * 342 draw calls and 770k triangles on seed 1 in a fight, more than half the
 * frame's shadow work and a third of all of it — though not one of those
 * meshes ever moves. So the baked city is drawn into a cache a margin larger
 * than the map, and each frame the map is a copy of the window of it the
 * shadow box covers (a framebuffer blit, colour and depth, at a whole-texel
 * offset because the box is snapped to texels), with only what moves —
 * hostiles, doors, drums, glass, drops — drawn over it, depth-tested against
 * the city's depth. The map that comes out is the map that went in.
 *
 * The box's depth along the light used to follow the player continuously,
 * which would change every depth in the cache with every step. The cache
 * holds it still instead (`depth`), anywhere from where it was to `DEPTH_SLACK`
 * further back, so the near plane never cuts closer than it did; the far
 * plane goes back by the slack and the bias is scaled down by as much, so it
 * is the same distance in metres.
 *
 * A new cache is drawn before the old one runs out: once the box has used
 * half its margin, a second buffer is drawn a quarter at a time over the
 * next frames and swapped in when it is whole, so walking never costs one
 * frame the whole city. Only a jump past the margin — a new run, a check
 * moving the player — draws it all at once.
 */
export const DEPTH_SLACK = 24;
const TILES = [[0, 0], [1, 0], [0, 1], [1, 1]];
const KEEP_VP = new THREE.Vector4(), KEEP_LP = new THREE.Vector3(), KEEP_TP = new THREE.Vector3();
const HOME_LP = new THREE.Vector3(), HOME_TP = new THREE.Vector3();

export class ShadowCache {
  /**
   * @param renderer the WebGLRenderer
   * @param light    the light whose map is cached (the sun)
   * @param statics  the group of meshes that never move (the baked city)
   */
  constructor(renderer, light, statics) {
    this.renderer = renderer;
    this.light = light;
    this.statics = statics;
    this.enabled = true;
    this.buffers = [];
    this.active = null;      // { rt, a, b, depth } the map is copied from
    this.pending = null;     // the one being drawn a tile a frame
    this.rebuilds = 0;       // whole caches drawn at once, for checks
    this.tiles = 0;          // tiles drawn
    const cam = light.shadow.camera;
    this.baseFar = cam.far;
    this.baseBias = light.shadow.bias;
    cam.far = this.baseFar + DEPTH_SLACK;
    cam.updateProjectionMatrix();
    light.shadow.bias = this.baseBias * (this.baseFar - cam.near) / (cam.far - cam.near);
    this.depth = null;
    const gl = renderer.getContext();
    this.maxSize = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    this.noop = () => {};
    this.still = null;       // the statics' children that never change
    this.movers = null;      // and the meshes among them that can (a drum)
    this.vis = [];
  }

  /**
   * What of the statics is cached. The baked city is, but a fire barrel is
   * left out of the merge so it can be shown burst (`unbaked` in
   * `bakeStatic`), and a cached drum would cast a whole drum's shadow over
   * its stump: the drums are drawn with what moves, every frame.
   */
  _sort() {
    if (this.still) return;
    this.movers = [];
    this.statics.traverse((o) => { if (o.userData.unbaked) this.movers.push(o); });
    this.still = this.statics.children.filter((ch) => {
      let moves = false;
      ch.traverse((o) => { if (o.userData.unbaked) moves = true; });
      return !moves;
    });
  }

  /** Hide (`true`) or put back each of `list`, keeping what was hidden. */
  _hide(list, on) {
    if (on) for (let i = 0; i < list.length; i++) { this.vis[i] = list[i].visible; list[i].visible = false; }
    else for (let i = 0; i < list.length; i++) list[i].visible = this.vis[i];
  }

  /** Forget everything drawn: a tier change, a new map size or span. */
  reset() {
    this.active = this.pending = null;
  }

  dispose() {
    for (const rt of this.buffers) rt.dispose();
    this.buffers = [];
    this.reset();
  }

  /** The shadow box's grid in texels, and its margin. */
  _grid() {
    const s = this.light.shadow;
    const size = s.mapSize.x, span = s.camera.right;
    const texel = (span * 2) / size;
    const margin = Math.max(32, size >> 4);
    return { size, span, texel, margin, n: size + margin * 2 };
  }

  _buffer(n, i) {
    let rt = this.buffers[i];
    if (rt && rt.width !== n) { rt.dispose(); rt = null; }
    if (!rt) {
      // made the way three makes a shadow map (`WebGLShadowMap`), so a
      // blit between them is between identical formats, colour and depth
      // and inside a reserve: it is made mid-run, where the seeded stream is
      // picking spawns, and a texture spends four of its numbers on a UUID
      rt = reserve(() => new THREE.WebGLRenderTarget(n, n));
      rt.texture.name = 'shadowCache';
      this.buffers[i] = rt;
    }
    return rt;
  }

  /** Point the light at (a, b) texels across the box and `depth` along it. */
  _aim(a, b, depth, texel) {
    const L = this.light;
    P.copy(X).multiplyScalar(a * texel).addScaledVector(Y, b * texel).addScaledVector(Z, depth);
    L.target.position.copy(P);
    L.position.copy(P).addScaledVector(SUN_DIR, SUN_DISTANCE);
    L.target.updateMatrixWorld();
    L.updateMatrixWorld();
  }

  /**
   * Draw the city into `cache`, centred where it says, all of it or one
   * quarter (`tile`), with three's own shadow pass pointed at the cache.
   */
  _draw(orig, cache, tile, grid, camera) {
    const s = this.light.shadow, cam = s.camera, L = this.light, r = this.renderer;
    const map = s.map, size = grid.size;
    const keep = [cam.left, cam.right, cam.top, cam.bottom];
    const vp = s._viewports[0];
    KEEP_VP.copy(vp); KEEP_LP.copy(L.position); KEEP_TP.copy(L.target.position);
    const half = grid.span * grid.n / grid.size;
    s.map = cache.rt;
    s.mapSize.set(grid.n, grid.n);
    this._aim(cache.a, cache.b, cache.depth, grid.texel);
    let clear = null;
    if (tile === null) {
      cam.left = -half; cam.right = half; cam.bottom = -half; cam.top = half;
    } else {
      const [i, j] = TILES[tile];
      cam.left = -half + i * half; cam.right = cam.left + half;
      cam.bottom = -half + j * half; cam.top = cam.bottom + half;
      vp.set(i * 0.5, j * 0.5, 0.5, 0.5);
      // the first quarter clears the cache, the rest draw beside it
      if (tile > 0) { clear = r.clear; r.clear = this.noop; }
    }
    cam.updateProjectionMatrix();
    this._hide(this.movers, true);
    orig([L], this.statics, camera);
    this._hide(this.movers, false);
    if (clear) r.clear = clear;
    s.map = map;
    s.mapSize.set(size, size);
    [cam.left, cam.right, cam.top, cam.bottom] = keep;
    cam.updateProjectionMatrix();
    vp.copy(KEEP_VP);
    L.position.copy(KEEP_LP); L.target.position.copy(KEEP_TP);
    L.target.updateMatrixWorld(); L.updateMatrixWorld();
  }

  /** Copy the window of the cache the box covers into the light's map. */
  _blit(cache, a, b, grid) {
    const r = this.renderer, gl = r.getContext(), state = r.state;
    const src = r.properties.get(cache.rt).__webglFramebuffer;
    const dst = r.properties.get(this.light.shadow.map).__webglFramebuffer;
    const x = a - cache.a + grid.margin, y = b - cache.b + grid.margin, n = grid.size;
    state.setScissorTest(false);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
    gl.blitFramebuffer(x, y, x + n, y + n, 0, 0, n, n, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /**
   * Stand in for three's shadow pass for this one light. `orig` is three's
   * own `WebGLShadowMap.render`.
   */
  render(orig, scene, camera) {
    const L = this.light;
    // the light is aimed at the cache's depth only while the pass draws, and
    // put back where placeShadow left it after: a frame drawn again without
    // a step, as a paused one is, must read the box where it is, not where
    // the last pass aimed it. The receivers read the matrix the pass made,
    // and a light's direction is the same either way.
    HOME_LP.copy(L.position); HOME_TP.copy(L.target.position);
    this._render(orig, scene, camera);
    L.position.copy(HOME_LP); L.target.position.copy(HOME_TP);
    L.target.updateMatrixWorld(); L.updateMatrixWorld();
  }

  _render(orig, scene, camera) {
    const L = this.light, s = L.shadow;
    const grid = this._grid();
    // where placeShadow put the box this frame: whole texels across it, and
    // the depth along the light it would have had
    const a = Math.round(L.target.position.dot(X) / grid.texel);
    const b = Math.round(L.target.position.dot(Y) / grid.texel);
    const c = L.target.position.dot(Z);
    const holds = (d) => d !== null && d >= c && d <= c + DEPTH_SLACK;

    this._sort();
    const usable = this.enabled && this.statics.visible && s.map && grid.n <= this.maxSize;
    if (!usable) {
      // drawn whole, as three would, at the depth the cache would use
      this.reset();
      if (!holds(this.depth)) this.depth = c + DEPTH_SLACK / 2;
      this._aim(a, b, this.depth, grid.texel);
      orig([L], scene, camera);
      return;
    }

    const same = (k) => k && k.n === grid.n && k.span === grid.span;
    if (this.pending && !same(this.pending)) this.pending = null;
    // the next cache is drawn a quarter a frame, and takes over when whole
    if (this.pending) {
      this._draw(orig, this.pending, this.pending.next, grid, camera);
      this.tiles++;
      if (++this.pending.next === TILES.length) { this.active = this.pending; this.pending = null; }
    }
    const k = this.active;
    const fits = same(k) && holds(k.depth)
      && Math.abs(a - k.a) <= grid.margin && Math.abs(b - k.b) <= grid.margin;
    if (!fits) {
      // a jump past the margin: there is nothing to copy, so draw it whole
      const free = k && k.rt === this.buffers[0] ? 1 : 0;
      this.pending = null;
      this.active = { rt: this._buffer(grid.n, free), a, b, depth: c + DEPTH_SLACK / 2, n: grid.n, span: grid.span };
      this._draw(orig, this.active, null, grid, camera);
      this.rebuilds++;
    } else if (!this.pending) {
      // half the margin used, or the depth near either end of its slack:
      // start the next one, centred where the box is now
      const off = Math.max(Math.abs(a - k.a), Math.abs(b - k.b)) > grid.margin / 2;
      const deep = k.depth - c < DEPTH_SLACK / 6 || k.depth - c > DEPTH_SLACK * 5 / 6;
      if (off || deep) {
        const free = k.rt === this.buffers[0] ? 1 : 0;
        this.pending = {
          rt: this._buffer(grid.n, free), a, b, n: grid.n, span: grid.span, next: 0,
          depth: deep ? c + DEPTH_SLACK / 2 : k.depth,
        };
      }
    }
    this.depth = this.active.depth;
    this._aim(a, b, this.depth, grid.texel);

    // the city's shadow, then what moves drawn over it, without a clear
    this._blit(this.active, a, b, grid);
    const r = this.renderer, clear = r.clear;
    r.clear = this.noop;
    this._hide(this.still, true);
    orig([L], scene, camera);
    this._hide(this.still, false);
    r.clear = clear;
  }
}
