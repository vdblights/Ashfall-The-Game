/**
 * The frame-rate readout, and what the browser says it is drawing with.
 *
 * Every frame-rate figure this repo has ever measured came from software
 * rendering in a headless browser, and every report of lag came from a
 * machine nobody here could see. This is the other end of that: ` (the key
 * left of 1) or "Show frame rate" in the pause menu puts the numbers on
 * screen, so a report can carry them — frames a second, the frame time and
 * the worst one, how much of it was the CPU, the tier and the resolution
 * `auto` has settled on, draw calls, whether the mouse is captured, and the
 * GPU's own name.
 *
 * It also lists stalls: every frame the browser itself reports as over 50 ms
 * (the Long Animation Frames API, `long-animation-frame` entries), how long
 * the worst of the last ten seconds took and which script took most of it.
 * That is the one thing a report from a machine nobody here can see could
 * never carry: not that the frame rate was low, but which frame hitched and
 * why. Chrome and Edge have it; elsewhere the line says so and nothing else
 * changes. The observer runs whether or not the readout is shown, because a
 * stall is worth reading after it happened, and it costs nothing between
 * long frames.
 *
 * It costs nothing while hidden: a ring of three numbers a frame. While it
 * is shown, draw calls are counted across the whole frame rather than the
 * last pass, and the text is rewritten four times a second, not every frame.
 */

import { Vector2 } from 'three';

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;
const RING = 240;
const STALL_RING = 64;
const STALL_WINDOW = 10000;

/** Short name for where a long frame's script came from. */
function scriptLabel(sc) {
  const file = String(sc.sourceURL || '').split(/[?#]/)[0].split('/').pop();
  const fn = sc.sourceFunctionName || '';
  if (file && fn) return `${file} ${fn}`;
  return file || fn || String(sc.invoker || sc.invokerType || 'script');
}

/** What the browser reports drawing with: the unmasked name where it gives one. */
export function gpuName(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(name || 'unknown');
  } catch {
    return 'unknown';
  }
}

/** True when there is no graphics card behind the canvas at all. */
export const isSoftware = (name) => SOFTWARE.test(name);

export class PerfMeter {
  constructor(renderer) {
    this.renderer = renderer;
    this.gpu = gpuName(renderer.getContext());
    this.software = isSoftware(this.gpu);
    // start, interval and cpu time of each recent frame, in ms
    this.began = new Float64Array(RING);
    this.cpu = new Float32Array(RING);
    this.sim = new Float32Array(RING);
    this.count = 0;
    this.visible = false;
    this.drawnAt = 0;
    this.calls = 0;
    this.tris = 0;
    // long animation frames, newest last: [startTime, duration, blocking, label]
    this.stallLog = [];
    this.stallsSupported = false;
    try {
      const types = (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes) || [];
      if (types.includes('long-animation-frame')) {
        this.stallsSupported = true;
        this.observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) this.noteStall(e);
        });
        this.observer.observe({ type: 'long-animation-frame', buffered: true });
      }
    } catch {
      this.stallsSupported = false;
    }
    this.el = document.createElement('div');
    this.el.id = 'perf';
    this.el.className = 'hidden';
    // a manual popover sits in the top layer, so it still shows over the
    // menus, which are modal dialogs there too (`screens.js` re-raises it)
    if ('popover' in HTMLElement.prototype) this.el.popover = 'manual';
    (document.getElementById('app') || document.body).appendChild(this.el);
  }

  show(on) {
    this.visible = on;
    this.el.classList.toggle('hidden', !on);
    if (this.el.popover) {
      try { if (on) this.el.showPopover(); else this.el.hidePopover(); } catch { /* already in that state */ }
    }
    // a frame is a dozen render calls (passes, cascades, the gun); count all
    this.renderer.info.autoReset = !on;
  }

  beforeRender() {
    if (this.visible) this.renderer.info.reset();
  }

  /** Record one frame: when it began, when the simulation ended, when it was issued. */
  frame(began, stepped, ended) {
    const i = this.count % RING;
    this.began[i] = began;
    this.cpu[i] = ended - began;
    this.sim[i] = stepped - began;
    this.count++;
    if (this.visible) {
      this.calls = this.renderer.info.render.calls;
      this.tris = this.renderer.info.render.triangles;
    }
  }

  /** Record one long animation frame, with the script that spent most of it. */
  noteStall(e) {
    let top = null;
    for (const sc of e.scripts || []) if (!top || sc.duration > top.duration) top = sc;
    this.stallLog.push([e.startTime, e.duration, e.blockingDuration || 0, top ? scriptLabel(top) : 'rendering']);
    if (this.stallLog.length > STALL_RING) this.stallLog.shift();
  }

  /** The long frames of the last `ms`: how many, the worst, and what it ran. */
  stalls(now = performance.now(), ms = STALL_WINDOW) {
    const recent = this.stallLog.filter((s) => now - s[0] <= ms);
    let worst = null;
    for (const s of recent) if (!worst || s[1] > worst[1]) worst = s;
    return {
      supported: this.stallsSupported,
      count: recent.length,
      worst: worst ? worst[1] : 0,
      blocking: worst ? worst[2] : 0,
      cause: worst ? worst[3] : '',
    };
  }

  /** Frame statistics over the last `seconds`, or null before there are two frames. */
  stats(seconds = 1) {
    const n = Math.min(this.count, RING);
    if (n < 2) return null;
    const last = (this.count - 1) % RING;
    const now = this.began[last];
    const gaps = [], cpu = [], sim = [];
    for (let k = 1; k < n; k++) {
      const i = (this.count - 1 - k + RING) % RING;
      const j = (i + 1) % RING;
      if (now - this.began[i] > seconds * 1000) break;
      gaps.push(this.began[j] - this.began[i]);
      cpu.push(this.cpu[j]);
      sim.push(this.sim[j]);
    }
    if (!gaps.length) return null;
    const span = gaps.reduce((a, b) => a + b, 0);
    const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    return {
      fps: (gaps.length * 1000) / span,
      frame: median(gaps),
      worst: Math.max(...gaps),
      cpu: median(cpu),
      sim: median(sim),
    };
  }

  /** Rewrite the readout, at most four times a second. */
  draw(game, now) {
    if (!this.visible || now - this.drawnAt < 250) return;
    this.drawnAt = now;
    const s = this.stats(1);
    const size = game.renderer.getDrawingBufferSize(SIZE);
    const ratio = game.renderer.getPixelRatio();
    const tier = (game.activeTier || '?').toUpperCase();
    const q = game.settings.quality === 'auto' ? `AUTO → ${tier}` : tier;
    const mouse = game.input.locked ? (game.input.raw ? 'captured, raw' : 'captured') : game.input.fallback ? 'STEERING — not captured' : 'not captured';
    const lines = [
      s ? `<b>${s.fps.toFixed(0)} fps</b> · ${s.frame.toFixed(1)} ms · worst ${s.worst.toFixed(1)}` : '— fps',
      s ? `cpu ${s.cpu.toFixed(1)} ms (game ${s.sim.toFixed(1)})` : '',
      `${q} · ${ratio.toFixed(2)}x · ${size.x}×${size.y}`,
      `${this.calls} calls · ${(this.tris / 1000).toFixed(0)}k tris`,
      `mouse ${mouse}`,
      this.stallLine(),
      this.gpu,
    ];
    if (this.software) lines.push('<i>NO GPU — hardware acceleration is off</i>');
    this.el.innerHTML = lines.filter(Boolean).join('<br>');
  }

  stallLine() {
    if (!this.stallsSupported) return 'stalls: not reported by this browser';
    const st = this.stalls();
    if (!st.count) return 'stalls 0 in 10 s';
    const cause = st.cause.replace(/[<>&]/g, '');
    return `stalls ${st.count} in 10 s · worst ${st.worst.toFixed(0)} ms · ${cause}`;
  }
}

// a Vector2 mints no UUID, so it costs the seeded stream nothing
const SIZE = new Vector2();
