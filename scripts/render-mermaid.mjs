// scripts/render-mermaid.mjs OUT_DIR file.md... — render every ```mermaid block of the given markdown files to PNG (Playwright Chromium, mermaid 11 from jsDelivr), so a diagram can be looked at before it is committed. Exits 1 and lists any block that fails to parse.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const out = process.argv[2]; const files = process.argv.slice(3);
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
for (const f of files) {
  const blocks = [...readFileSync(f, 'utf8').matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const [i, code] of blocks.entries()) {
    const html = `<!doctype html><html><body style="margin:0;background:#fff;font-family:-apple-system,Segoe UI,sans-serif"><div id="d"></div>
      <script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
      mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
      try { const { svg } = await mermaid.render('g', ${JSON.stringify(code)}); document.getElementById('d').innerHTML = svg; document.title = 'ok'; }
      catch (e) { document.title = 'ERR ' + e.message; }</script></body></html>`;
    await page.setContent(html); await page.waitForFunction(() => document.title !== '', null, { timeout: 30000 });
    const title = await page.title(); const name = `${basename(f, '.md')}-${i + 1}.png`;
    if (title.startsWith('ERR')) { errors.push(`${name}: ${title}`); continue; }
    await page.locator('#d svg').screenshot({ path: `${out}/${name}` });
    const box = await page.locator('#d svg').boundingBox(); console.log(name, Math.round(box.width) + 'x' + Math.round(box.height));
  }
}
await browser.close(); if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
