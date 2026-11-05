'use strict';

// Renders each compiled email (dist/*.html) in headless Chromium and saves
// PNG screenshots to previews/: desktop, mobile and dark mode.
// Run after `npm run build:emails`.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const previewDir = path.join(root, 'previews');

const variants = [
  { name: 'desktop', viewport: { width: 800, height: 900 }, colorScheme: 'light' },
  { name: 'mobile', viewport: { width: 375, height: 800 }, colorScheme: 'light', deviceScaleFactor: 2 },
  { name: 'dark', viewport: { width: 800, height: 900 }, colorScheme: 'dark' },
];

async function main() {
  const manifestPath = path.join(distDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('dist/manifest.json not found. Run npm run build:emails first.');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  fs.rmSync(previewDir, { recursive: true, force: true });
  fs.mkdirSync(previewDir, { recursive: true });

  const browser = await chromium.launch();
  const results = [];
  let failed = false;

  try {
    for (const template of manifest.templates) {
      const url = 'file://' + path.join(distDir, template.html);
      const base = template.html.replace(/\.html$/, '');
      for (const variant of variants) {
        const context = await browser.newContext({
          viewport: variant.viewport,
          colorScheme: variant.colorScheme,
          deviceScaleFactor: variant.deviceScaleFactor ?? 1,
        });
        const page = await context.newPage();
        const failedImages = [];
        page.on('requestfailed', (request) => {
          if (request.resourceType() === 'image') failedImages.push(request.url());
        });
        page.on('response', (response) => {
          if (response.request().resourceType() === 'image' && response.status() >= 400) {
            failedImages.push(`${response.url()} (HTTP ${response.status()})`);
          }
        });
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
          const file = `${base}-${variant.name}.png`;
          await page.screenshot({ path: path.join(previewDir, file), fullPage: true });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
          );
          results.push({ file, overflow, failedImages });
          const notes = [];
          if (overflow > 0) notes.push(`horizontal overflow ${overflow}px`);
          if (failedImages.length) notes.push(`${failedImages.length} image(s) failed to load`);
          console.log(`${notes.length ? 'WARN' : 'OK  '}: ${file}${notes.length ? ' - ' + notes.join('; ') : ''}`);
          for (const img of failedImages) console.log(`  - ${img}`);
          if (failedImages.length) failed = true;
        } catch (error) {
          failed = true;
          console.error(`FAILED: ${base}-${variant.name}: ${error.message}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(
    path.join(previewDir, 'previews.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2) + '\n'
  );
  if (failed) {
    console.error('Preview rendering finished with failures.');
    process.exit(1);
  }
  console.log(`Rendered ${results.length} previews into previews/.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
