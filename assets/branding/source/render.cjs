const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  for (const [name, w, h] of process.argv.slice(3).map(s => s.split(':'))) {
    const svg = fs.readFileSync(`${process.argv[2]}/${name}.svg`, 'utf8');
    await p.setViewportSize({ width: +w, height: +h });
    await p.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(200);
    await p.screenshot({ path: `${process.argv[2]}/${name}.png`, omitBackground: true, clip: { x: 0, y: 0, width: +w, height: +h } });
  }
  await b.close();
})();
