// Renders one SVG to square PNGs: node render-icons.cjs favicon.svg out.png:32 ...
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const [src, ...outs] = process.argv.slice(2);
  const svg = fs.readFileSync(src, 'utf8');
  for (const o of outs) { const [file, n] = o.split(':');
    await p.setViewportSize({ width: +n, height: +n });
    await p.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${n}" height="${n}" `)}</body></html>`);
    await p.screenshot({ path: file, clip: { x: 0, y: 0, width: +n, height: +n } }); }
  await b.close(); })();
