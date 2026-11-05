'use strict';

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

module.exports = { decodeEntities, getAttribute, lineOf };
