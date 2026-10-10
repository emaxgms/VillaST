#!/usr/bin/env node
/**
 * build-en.mjs — generate the English page (/en/index.html) from index.html.
 *
 *     node tools/build-en.mjs
 *
 * Why a generator: index.html is the single source of truth for the markup. The
 * English page is the same document with (a) the non-English language elements
 * dropped, (b) the head/OG/JSON-LD metadata swapped, (c) `alt` and `placeholder`
 * attributes taken from their data-alt-en / data-placeholder-en twins.
 *
 * The output is committed — Firebase Hosting still sees a plain static site with
 * no build step at deploy time. Run this after ANY edit to index.html, otherwise
 * /en/ silently drifts; the script asserts the two files stay in sync.
 *
 * Ceiling: this is regex templating, not a DOM parser. It relies on the class
 * token convention `<span class="it">` / `class="en"` and on language elements
 * never nesting inside each other. The assertions below fail loudly if that
 * assumption ever breaks (a leftover `class="it"` or a changed section count).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'index.html');
const OUT = join(ROOT, 'en', 'index.html');
const BASE = 'https://villa-serenita-san-teodoro.web.app';

const EN = {
  title: 'Holiday Rental in San Teodoro, Sardinia — Rifugio Tavolara',
  description:
    '4-guest apartment in central San Teodoro: 2 bedrooms, private garden, terrace and free parking. Cala d&rsquo;Ambra beach 1.5 km away. Book direct with the host.',
  ogDescription:
    '4-guest apartment in central San Teodoro with private garden, terrace and free parking. Book direct with the host.',
  ogAlt: 'Rifugio Tavolara, a holiday home in San Teodoro, Sardinia',
  jsonld:
    "4-guest apartment in central San Teodoro, Sardinia: 2 bedrooms, 1 bathroom, fitted kitchen, private garden, terrace, patio and free parking. Cala d'Ambra 1.5 km away, Olbia airport 24 km.",
};

/** class attribute contains the standalone token `lang` ("it" or "en") */
const langToken = (lang) => new RegExp(`(^|\\s)${lang}(\\s|$)`);

/**
 * Remove every element whose class carries the `it` token, matched by counting
 * nested same-name tags (a simple non-greedy regex pair breaks on
 * `<span class="w"><span class="it">...</span></span>`).
 */
function stripNonEnglish(html) {
  const opener = /<([a-zA-Z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const ranges = [];
  let m;

  while ((m = opener.exec(html)) !== null) {
    const tag = m[1];
    const attrs = m[2];
    if (/\/\s*$/.test(attrs)) continue; // self-closing tag
    const cls = /\bclass="([^"]*)"/.exec(attrs);
    if (!cls || !langToken('it').test(cls[1])) continue;

    const scan = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi');
    scan.lastIndex = opener.lastIndex;
    let depth = 1;
    let closing;
    while ((closing = scan.exec(html)) !== null) {
      depth += closing[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        ranges.push([m.index, scan.lastIndex]);
        break;
      }
    }
    if (depth !== 0) throw new Error(`unbalanced <${tag}> at ${m.index} while stripping Italian`);
  }

  // merge overlaps, then cut from the end so earlier offsets stay valid
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    html = html.slice(0, merged[i][0]) + html.slice(merged[i][1]);
  }
  return html;
}

function swap(html, oldText, newText, label, expected = 1) {
  const found = html.split(oldText).length - 1;
  if (found !== expected) {
    throw new Error(`[${label}] expected ${expected} occurrence(s), found ${found}`);
  }
  return html.split(oldText).join(newText);
}

let html = readFileSync(SRC, 'utf8');
const sourceSections = (html.match(/<section /g) || []).length;

// ── 1. drop the Italian content ────────────────────────────────────────────
html = stripNonEnglish(html);

// ── 2. document language ───────────────────────────────────────────────────
html = swap(html, '<html lang="it">', '<html lang="en">', 'html lang');
html = swap(html, '<body class="lang-it">', '<body class="lang-en">', 'body class');

// ── 3. per-image alt text + form placeholders ──────────────────────────────
html = html.replace(
  /alt="([^"]*)"(\s*)data-alt-en="([^"]*)"/g,
  (_m, _it, _ws, en) => `alt="${en}"`
);
html = html.replace(/<input[^>]*data-placeholder-[^>]*>/g, (tag) => {
  const en = /data-placeholder-en="([^"]*)"/.exec(tag);
  if (!en) throw new Error(`input without data-placeholder-en: ${tag}`);
  return tag
    .replace(/placeholder="[^"]*"/, `placeholder="${en[1]}"`)
    .replace(/\s*data-placeholder-it="[^"]*"/g, '')
    .replace(/\s*data-placeholder-en="[^"]*"/g, '');
});

// ── 4. head metadata ──────────────────────────────────────────────────────
html = swap(
  html,
  '<title>Casa Vacanze San Teodoro, Sardegna — Rifugio Tavolara</title>',
  `<title>${EN.title}</title>`,
  'title'
);
html = swap(
  html,
  'content="Appartamento per 4 ospiti nel centro di San Teodoro: 2 camere, giardino privato, terrazza e parcheggio gratuito. Cala d&rsquo;Ambra a 1,5 km. Prenota diretto con l&rsquo;host.">',
  `content="${EN.description}">`,
  'meta description'
);
html = swap(html, `<link rel="canonical" href="${BASE}/">`, `<link rel="canonical" href="${BASE}/en/">`, 'canonical');
html = swap(html, '<meta property="og:locale" content="it_IT">', '<meta property="og:locale" content="en_GB">', 'og locale');
html = swap(
  html,
  '<meta property="og:locale:alternate" content="en_GB">',
  '<meta property="og:locale:alternate" content="it_IT">',
  'og locale alternate'
);
html = swap(
  html,
  '<meta property="og:title" content="Casa Vacanze San Teodoro, Sardegna — Rifugio Tavolara">',
  `<meta property="og:title" content="${EN.title}">`,
  'og title'
);
html = swap(html, /og:description[\s\S]*?content="[^"]*">/.exec(html)[0], `<meta property="og:description" content="${EN.ogDescription}">`, 'og description');
html = swap(html, `<meta property="og:url" content="${BASE}/">`, `<meta property="og:url" content="${BASE}/en/">`, 'og url');
html = swap(
  html,
  '<meta property="og:image:alt" content="Rifugio Tavolara, casa vacanze a San Teodoro, Sardegna">',
  `<meta property="og:image:alt" content="${EN.ogAlt}">`,
  'og image alt'
);

// ── 5. structured data ────────────────────────────────────────────────────
const jsonldBlock = /(<!-- jsonld:start -->)([\s\S]*?)(<!-- jsonld:end -->)/.exec(html);
if (!jsonldBlock) throw new Error('JSON-LD markers not found in index.html');
const jsonldEn = jsonldBlock[2]
  .replace(/"url": "[^"]*"/, `"url": "${BASE}/en/"`)
  .replace(/"inLanguage": "[^"]*"/, '"inLanguage": "en"')
  .replace(/"description": "[\s\S]*?",\n/, `"description": ${JSON.stringify(EN.jsonld)},\n`);
if (/"inLanguage": "en"/.test(jsonldEn) === false) throw new Error('JSON-LD rewrite failed');
html = html.replace(jsonldBlock[0], `${jsonldBlock[1]}${jsonldEn}${jsonldBlock[3]}`);

// ── 6. the two cross-language links ───────────────────────────────────────
html = swap(
  html,
  '<a class="lang-toggle" href="/en/" hreflang="en" lang="en" aria-label="Switch to English">IT | EN</a>',
  '<a class="lang-toggle" href="/" hreflang="it" lang="it" aria-label="Passa all\'italiano">EN | IT</a>',
  'nav language switch'
);
html = swap(
  html,
  '<p class="footer-lang"><a href="/en/" hreflang="en" lang="en">English version</a></p>',
  '<p class="footer-lang"><a href="/" hreflang="it" lang="it">Versione italiana</a></p>',
  'footer language link'
);

// ── 6b. root-absolute asset paths ─────────────────────────────────────────
// index.html lives at /, this copy at /en/: every relative css/js/images URL would
// resolve under /en/ and 404. `#anchor` links stay relative (they are same-page).
html = html.replace(/(href|src)="(css|js|images)\//g, '$1="/$2/');

// ── 7. assertions before writing ──────────────────────────────────────────
const problems = [];
const expectGone = [
  [/class="[^"]*\bit\b[^"]*"/, 'leftover Italian language element'],
  [/data-alt-en/, 'leftover data-alt-en'],
  [/data-placeholder/, 'leftover data-placeholder'],
  [/unpkg\.com/, 'reference to the removed AOS CDN'],
  [/<html lang="it">/, 'leftover <html lang="it">'],
  [/(href|src)="(css|js|images)\//, 'relative asset path (would 404 under /en/)'],
];
for (const [re, label] of expectGone) {
  const n = (html.match(re) || []).length;
  if (n) problems.push(`${label}: ${n}`);
}
if (!html.includes(`<link rel="canonical" href="${BASE}/en/">`)) problems.push('missing EN canonical');
if (!html.includes('<body class="lang-en">')) problems.push('missing body.lang-en');
const outSections = (html.match(/<section /g) || []).length;
if (outSections !== sourceSections) {
  problems.push(`section count drift: ${outSections} vs ${sourceSections}`);
}
if (problems.length) {
  console.error('BUILD FAILED:\n - ' + problems.join('\n - '));
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, 'utf8');
console.log(`wrote ${OUT.replace(ROOT + '/', '')} (${html.length} bytes, ${outSections} sections)`);
