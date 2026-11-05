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


// ---- Output validation -----------------------------------------------------
// Gmail clips messages larger than ~102 KB (102 * 1024 bytes).
const GMAIL_CLIP_LIMIT = 102 * 1024;
const isCI = process.env.CI === 'true';

const decodeEntities = (value) =>
  value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

const getAttribute = (tag, name) => {
  const match = tag.match(
    new RegExp(`\\s${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=[\\s/>])`, 'i')
  );
  if (!match) return undefined; // attribute absent
  const value = match[1] ?? match[2] ?? match[3] ?? '';
  return decodeEntities(value).trim();
};

const lineOf = (html, index) => html.slice(0, index).split('\n').length;

// Returns { problems: string[], links: Map<url, line> } for one compiled email.
function validateHtml(html, bytes) {
  const problems = [];
  const links = new Map();

  if (bytes > GMAIL_CLIP_LIMIT) {
    problems.push(
      `size ${bytes} bytes exceeds Gmail's ~102 KB clipping limit (${GMAIL_CLIP_LIMIT} bytes)`
    );
  }

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const line = lineOf(html, match.index);
    // alt="" is allowed (decorative image); a missing attribute is not.
    if (getAttribute(tag, 'alt') === undefined) {
      problems.push(`line ${line}: <img> is missing its alt attribute`);
    }
    const src = getAttribute(tag, 'src');
    if (!src || !/^https:\/\/[^/\s]+/i.test(src)) {
      problems.push(`line ${line}: <img> src must be a full https:// URL (got "${src ?? ''}")`);
    }
  }

  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const line = lineOf(html, match.index);
    const href = getAttribute(match[0], 'href');
    if (!href || href === '#') {
      problems.push(`line ${line}: <a> has an empty href (got "${href ?? ''}")`);
      continue;
    }
    if (/^(mailto|tel|sms):/i.test(href)) {
      if (/^mailto:\s*$/i.test(href)) problems.push(`line ${line}: empty mailto: link`);
      continue;
    }
    if (/^http:\/\//i.test(href)) {
      problems.push(`line ${line}: link uses insecure http:// (${href})`);
      continue;
    }
    if (/^https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i.test(href)) {
      problems.push(`line ${line}: link points to localhost (${href})`);
      continue;
    }
    if (!/^https:\/\/[^/\s]+/i.test(href)) {
      problems.push(`line ${line}: link is not a full https:// URL (${href})`);
      continue;
    }
    if (!links.has(href)) links.set(href, line);
  }

  return { problems, links };
}

// CI only: any link answering 4xx/5xx fails the build.
async function checkLink(url) {
  const attempt = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'taskcurrent-email-link-check' },
      });
      return response.status;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let status = await attempt('HEAD');
    // Some servers reject HEAD; retry with GET before judging.
    if (status >= 400) status = await attempt('GET');
    return status >= 400 ? `HTTP ${status}` : null;
  } catch (error) {
    return `request failed (${error.name === 'AbortError' ? 'timeout' : error.message})`;
  }
}

async function main() {

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

  const { problems, links } = validateHtml(html.toString('utf8'), html.length);
  if (problems.length) {
    failed = true;
    console.error(`INVALID: ${source}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    continue;
  }

  if (isCI) {
    const results = await Promise.all(
      [...links].map(async ([url, line]) => [url, line, await checkLink(url)])
    );
    const broken = results.filter(([, , error]) => error);
    if (broken.length) {
      failed = true;
      console.error(`BROKEN LINKS: ${source}`);
      for (const [url, line, error] of broken) console.error(`  - line ${line}: ${url} -> ${error}`);
      continue;
    }
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
