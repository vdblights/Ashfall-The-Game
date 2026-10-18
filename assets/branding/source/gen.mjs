// Generates the ASHFALL logo, X avatar and X banner as self-contained SVGs.
import fs from 'node:fs';
const OUT = process.argv[2];
const font = fs.readFileSync(new URL('./rajdhani700.woff2', import.meta.url)).toString('base64');
const FONT = `@font-face{font-family:R;font-weight:700;src:url(data:font/woff2;base64,${font}) format('woff2');}`;

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Wordmark: squared, chamfered letters drawn as 16-unit strokes on a 100-unit cap height.
const GLYPH = {
  A: [70, 'M8,100 V28 L28,8 H42 L62,28 V100 M8,62 H62'],
  S: [70, 'M70,8 H26 L8,26 V36 L26,54 H44 L62,72 V74 L44,92 H0'],
  H: [70, 'M8,0 V100 M62,0 V100 M8,54 H62'],
  F: [64, 'M8,100 V8 H64 M8,54 H50'],
  L: [62, 'M8,0 V92 H62'],
};
const GAP = 16;
function wordmark(word) {
  let x = 0; const parts = [];
  for (const ch of word) { const [w, d] = GLYPH[ch]; parts.push(`<path transform="translate(${x} 0)" d="${d}"/>`); x += w + GAP; }
  return { width: x - GAP, body: parts.join('') };
}
const WM = wordmark('ASHFALL');
// A crack through the letters: a jagged cut, the lower half dropped 3 units.
const CRACK = 'M-10,47 L90,52 L140,45 L230,57 L300,49 L380,58 L460,50 L570,55';

function wordmarkDefs(id) {
  return `
  <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffd58c"/><stop offset="0.55" stop-color="#ffb347"/><stop offset="1" stop-color="#c2621b"/>
  </linearGradient>
  <filter id="${id}glow" x="-20%" y="-40%" width="140%" height="180%">
    <feGaussianBlur stdDeviation="6" result="b"/>
    <feColorMatrix in="b" values="1 0 0 0 0  0 .55 0 0 0  0 0 .15 0 0  0 0 0 .55 0"/>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <mask id="${id}top" maskUnits="userSpaceOnUse" x="-20" y="-20" width="600" height="140">
    <path d="${CRACK} V-20 H-10 Z" fill="#fff"/><path d="${CRACK}" stroke="#000" stroke-width="2.4" fill="none"/>
  </mask>
  <mask id="${id}bot" maskUnits="userSpaceOnUse" x="-20" y="-20" width="600" height="140">
    <path d="${CRACK} V140 H-10 Z" fill="#fff"/><path d="${CRACK}" stroke="#000" stroke-width="2.4" fill="none"/>
  </mask>`;
}
function wordmarkUse(id, tx, ty, s) {
  const g = `<g fill="none" stroke="url(#${id}g)" stroke-width="16" stroke-linejoin="miter" stroke-miterlimit="4">${WM.body}</g>`;
  return `<g transform="translate(${tx} ${ty}) scale(${s})" filter="url(#${id}glow)">
    <g mask="url(#${id}top)">${g}</g>
    <g mask="url(#${id}bot)" transform="translate(1.5 3)">${g}</g>
  </g>`;
}

// A ruined skyline between x0 and x1 standing on y=base, heights scaled by h.
function skyline(r, x0, x1, base, h, fill, windows) {
  let x = x0, out = '';
  while (x < x1) {
    const w = 18 + r() * 46, top = base - (0.25 + r() * 0.75) * h;
    const pts = [[x, base], [x, top]];
    if (r() < 0.45) { // broken top: a notch or a slope
      const a = x + w * (0.2 + r() * 0.3), b = x + w * (0.55 + r() * 0.3), d = 6 + r() * 22;
      pts.push([a, top], [a + (b - a) * 0.4, top + d], [b, top + d * 0.3], [b, top + r() * 4]);
    } else if (r() < 0.25) { // a mast or a tank
      pts.push([x + w * 0.6, top], [x + w * 0.6, top - 10 - r() * 18], [x + w * 0.64, top - 10 - r() * 18], [x + w * 0.64, top]);
    }
    pts.push([x + w, top + (r() < 0.3 ? r() * 10 : 0)], [x + w, base]);
    out += `<path d="M${pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' L')} Z" fill="${fill}"/>`;
    if (windows) for (let y = top + 10; y < base - 8; y += 11) for (let wx = x + 5; wx < x + w - 6; wx += 9)
      if (r() < 0.035) out += `<rect x="${wx.toFixed(1)}" y="${y.toFixed(1)}" width="3" height="4" fill="#ff9a3c" opacity="${(0.4 + r() * 0.5).toFixed(2)}"/>`;
    x += w + (r() < 0.2 ? 4 + r() * 10 : -2);
  }
  return out;
}
function ash(r, n, W, H, maxR) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = r() * W, y = r() * H, s = 0.6 + r() ** 3 * maxR, ember = r() < 0.12;
    out += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${s.toFixed(2)}" ry="${(s * 0.7).toFixed(2)}" transform="rotate(${(r() * 180).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${ember ? '#ffb347' : '#c9c1b6'}" opacity="${(ember ? 0.5 + r() * 0.4 : 0.15 + r() * 0.4).toFixed(2)}"/>`;
  }
  return out;
}

// ---------- logo (transparent, wordmark + kicker) ----------
{
  const s = 2, W = WM.width * s + 80, H = 100 * s + 120;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><style>${FONT}</style>${wordmarkDefs('l')}</defs>
  ${wordmarkUse('l', 40, 30, s)}
  <text x="${W / 2}" y="${H - 34}" text-anchor="middle" font-family="R" font-weight="700" font-size="30" letter-spacing="12" fill="#d8c6ae">OPERATION · CARROW</text>
</svg>`;
  fs.writeFileSync(`${OUT}/ashfall-logo.svg`, svg);
  // a dark-background version for previews and anywhere transparency is not wanted
  fs.writeFileSync(`${OUT}/ashfall-logo-dark.svg`, svg.replace('</defs>', `</defs><rect width="${W}" height="${H}" fill="#0b0c0e"/>`));
}

// ---------- emblem / X avatar 400x400 ----------
{
  const r = rng(7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.55" r="0.65"><stop offset="0" stop-color="#3a1f12"/><stop offset="0.6" stop-color="#160f0c"/><stop offset="1" stop-color="#0b0c0e"/></radialGradient>
    <radialGradient id="sun" cx="0.5" cy="0.4" r="0.6"><stop offset="0" stop-color="#ffe2a8"/><stop offset="0.5" stop-color="#ffb347"/><stop offset="1" stop-color="#d0641c"/></radialGradient>
    <radialGradient id="halo"><stop offset="0" stop-color="#ff8a2a" stop-opacity="0.55"/><stop offset="1" stop-color="#ff8a2a" stop-opacity="0"/></radialGradient>
    <clipPath id="disc"><circle cx="200" cy="200" r="150"/></clipPath>
  </defs>
  <rect width="400" height="400" fill="url(#bg)"/>
  <circle cx="200" cy="205" r="170" fill="url(#halo)"/>
  <g clip-path="url(#disc)">
    <circle cx="200" cy="200" r="150" fill="#1a110d"/>
    <circle cx="200" cy="215" r="92" fill="url(#sun)"/>
    ${skyline(r, 40, 360, 300, 150, '#0b0c0e', true)}
    <rect x="40" y="298" width="320" height="60" fill="#0b0c0e"/>
  </g>
  <circle cx="200" cy="200" r="150" fill="none" stroke="#ffb347" stroke-width="5"/>
  <circle cx="200" cy="200" r="139" fill="none" stroke="#ffb347" stroke-opacity="0.35" stroke-width="1.5"/>
  ${[0, 90, 180, 270].map(a => `<rect x="197" y="38" width="6" height="22" fill="#ffb347" transform="rotate(${a} 200 200)"/>`).join('')}
  <g clip-path="url(#disc)">${ash(r, 70, 400, 400, 2.6)}</g>
</svg>`;
  fs.writeFileSync(`${OUT}/ashfall-x-avatar.svg`, svg);
}

// ---------- X banner 1500x500 ----------
{
  const r = rng(20261018), s = 1.45, tx = (1500 - WM.width * s) / 2, ty = 120;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
  <defs><style>${FONT}</style>${wordmarkDefs('b')}
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f0d0d"/><stop offset="0.5" stop-color="#2a1812"/><stop offset="0.82" stop-color="#6e3818"/><stop offset="1" stop-color="#8a4519"/></linearGradient>
    <radialGradient id="sunb" cx="0.5" cy="0.45" r="0.6"><stop offset="0" stop-color="#ffe2a8"/><stop offset="0.6" stop-color="#ffb347"/><stop offset="1" stop-color="#d0641c"/></radialGradient>
    <radialGradient id="haloB"><stop offset="0" stop-color="#ff8a2a" stop-opacity="0.45"/><stop offset="1" stop-color="#ff8a2a" stop-opacity="0"/></radialGradient>
    <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a4519" stop-opacity="0"/><stop offset="1" stop-color="#8a4519" stop-opacity="0.55"/></linearGradient>
  </defs>
  <rect width="1500" height="500" fill="url(#sky)"/>
  <circle cx="1230" cy="395" r="260" fill="url(#haloB)"/>
  <circle cx="1230" cy="395" r="62" fill="url(#sunb)"/>
  <g opacity="0.55">${skyline(r, -20, 1520, 470, 150, '#3b2116', false)}</g>
  <rect x="0" y="300" width="1500" height="170" fill="url(#haze)"/>
  <g>${skyline(r, -20, 1520, 500, 120, '#0b0c0e', true)}</g>
  ${ash(r, 260, 1500, 500, 3)}
  ${wordmarkUse('b', tx, ty, s)}
  <text x="${tx + WM.width * s / 2}" y="${ty + 100 * s + 52}" text-anchor="middle" font-family="R" font-weight="700" font-size="28" letter-spacing="9" fill="#e6d3b8">TWELVE WAVES IN A CITY BURIED IN ASH</text>
</svg>`;
  fs.writeFileSync(`${OUT}/ashfall-x-banner.svg`, svg);
}
