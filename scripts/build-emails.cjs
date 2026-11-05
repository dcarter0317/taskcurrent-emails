'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const outputDirectory = path.join(root, 'dist');
const mjmlCommand = path.join(root, 'node_modules', '.bin', 'mjml');

// Only actual emails are listed. styles.mjml and components/ are includes,
// not standalone emails; they are compiled into each output automatically.
const templates = [
  'demo_reminder.mjml',
  'demo_request_confirmation.mjml',
  'early_access.mjml',
  'early_access_product_intro.mjml',
  'post_demo_followup.mjml',
  'use_case.mjml',
];

if (!fs.existsSync(mjmlCommand)) {
  console.error('MJML executable not found. Run npm install (or npm ci) first.');
  process.exit(1);
}

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

const manifest = {
  project: 'taskcurrent',
  generated_at: new Date().toISOString(),
  template_count: templates.length,
  templates: [],
};

let failed = false;

for (const source of templates) {
  const inputFile = path.join(root, source);
  const htmlName = source.replace(/\.mjml$/, '.html');
  const outputFile = path.join(outputDirectory, htmlName);

  if (!fs.existsSync(inputFile)) {
    console.error(`MISSING: ${source}`);
    failed = true;
    continue;
  }

  const result = spawnSync(
    mjmlCommand,
    [
      source,
      '--output', outputFile,
      '--config.allowIncludes', 'true',
      '--config.validationLevel', 'strict',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
  );

  if (result.error || result.status !== 0) {
    failed = true;
    console.error(`FAILED: ${source}`);
    if (result.stdout) console.error(result.stdout.trim());
    if (result.stderr) console.error(result.stderr.trim());
    if (result.error) console.error(result.error.message);
    continue;
  }

  if (!fs.existsSync(outputFile)) {
    failed = true;
    console.error(`FAILED: ${source}: no HTML output created`);
    continue;
  }

  const html = fs.readFileSync(outputFile);
  if (!/<html[\s>]/i.test(html.toString('utf8')) || html.length < 500) {
    failed = true;
    console.error(`FAILED: ${source}: output does not look like a complete email`);
    continue;
  }

  manifest.templates.push({
    source,
    html: htmlName,
    bytes: html.length,
    sha256: crypto.createHash('sha256').update(html).digest('hex'),
  });
  console.log(`OK: ${source} -> dist/${htmlName} (${html.length} bytes)`);
}

if (failed || manifest.templates.length !== templates.length) {
  console.error('MJML build failed. No success manifest will be produced.');
  process.exit(1);
}

fs.writeFileSync(
  path.join(outputDirectory, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  'utf8'
);
console.log(`Compiled ${manifest.templates.length} MJML emails successfully.`);
