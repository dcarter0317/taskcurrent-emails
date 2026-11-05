'use strict';

const { decodeEntities, getAttribute, lineOf } = require('./helpers.cjs');

const stripTags = (value) =>
  decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

// Returns { errors: string[], warnings: string[] } for one compiled email.
function runQualityChecks(html, config) {
  const errors = [];
  const warnings = [];
  const genericText = new Set(config.genericLinkText.map((t) => t.toLowerCase()));

  // --- Document-level -------------------------------------------------------
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';
  if (!title) errors.push('missing or empty <title>');

  const lang = getAttribute((html.match(/<html\b[^>]*>/i) || [''])[0], 'lang');
  if (!lang || lang.toLowerCase() === 'und') {
    warnings.push(`<html lang> is ${lang ? `"${lang}"` : 'missing'}; set a real language (e.g. lang="en" on <mjml>)`);
  }

  const previewMatch = html.match(/<div[^>]*display:\s*none[^>]*>([\s\S]*?)<\/div>/i);
  const preview = previewMatch ? stripTags(previewMatch[1]) : '';
  if (!preview) warnings.push('no preview text found');
  else if (title && preview.toLowerCase() === title.toLowerCase()) {
    warnings.push(`preview text duplicates the title ("${title}")`);
  }

  // --- Images ---------------------------------------------------------------
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const line = lineOf(html, match.index);
    const src = getAttribute(tag, 'src');
    const host = src ? hostOf(src) : null;
    if (host && !config.allowedImageHosts.includes(host)) {
      errors.push(`line ${line}: image host "${host}" is not in allowedImageHosts`);
    }
    if (getAttribute(tag, 'width') === undefined || getAttribute(tag, 'height') === undefined) {
      warnings.push(`line ${line}: <img> has no width/height (layout shifts when images are blocked)`);
    }
  }

  // --- Links ----------------------------------------------------------------
  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const tag = match[0].slice(0, match[0].indexOf('>') + 1);
    const line = lineOf(html, match.index);
    const href = getAttribute(tag, 'href');

    // Link text: visible text, else aria-label, else a child image's alt.
    let text = stripTags(match[1]);
    if (!text) text = getAttribute(tag, 'aria-label') || '';
    if (!text) {
      const img = match[1].match(/<img\b[^>]*>/i);
      text = img ? getAttribute(img[0], 'alt') || '' : '';
    }
    if (!text) errors.push(`line ${line}: link has no accessible text (${href ?? ''})`);
    else if (genericText.has(text.toLowerCase())) {
      warnings.push(`line ${line}: generic link text "${text}"`);
    }

    if (!href) continue;
    if (href === '#') {
      warnings.push(`line ${line}: placeholder href="#" (text: "${text}")`);
      continue;
    }
    if (!/^https:\/\//i.test(href)) continue; // scheme problems are handled by validateHtml

    const host = hostOf(href);
    if (!host) {
      errors.push(`line ${line}: unparseable URL (${href})`);
      continue;
    }
    if (!config.allowedLinkHosts.includes(host)) {
      errors.push(`line ${line}: link host "${host}" is not in allowedLinkHosts (${href})`);
      continue;
    }

    if (config.utm.requiredOnHosts.includes(host)) {
      const params = new URL(href).searchParams;
      for (const [key, expected] of Object.entries(config.utm.fixed)) {
        const values = params.getAll(key);
        if (values.length === 0) errors.push(`line ${line}: missing ${key} (${href})`);
        else if (values.length > 1) warnings.push(`line ${line}: duplicate ${key} (${href})`);
        else if (values[0] !== expected) {
          errors.push(`line ${line}: ${key}="${values[0]}" should be "${expected}"`);
        }
      }
      for (const key of config.utm.requiredKeys) {
        if (!params.get(key)) errors.push(`line ${line}: missing ${key} (${href})`);
      }
      const content = params.get('utm_content');
      if (content && !new RegExp(config.utm.contentPattern).test(content)) {
        errors.push(`line ${line}: utm_content="${content}" must match ${config.utm.contentPattern}`);
      }
    }
  }

  return { errors, warnings };
}

module.exports = { runQualityChecks };
