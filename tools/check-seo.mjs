#!/usr/bin/env node
/**
 * check-seo.mjs — pre-deploy gate for the SEO/marketing invariants.
 *
 *     node tools/check-seo.mjs
 *
 * There is no test suite in this repo; this is the one runnable check. It catches
 * the failure mode that actually bites: index.html edited, tools/build-en.mjs not
 * rerun, so /en/ silently drifts or a meta tag goes missing. Exits non-zero on any
 * violation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://villa-serenita-san-teodoro.web.app';

const checks = [];
const add = (ok, message) => checks.push({ ok, message });

const pages = [
  { file: 'index.html', lang: 'it', canonical: `${BASE}/`, title: /Casa Vacanze San Teodoro/ },
  { file: 'en/index.html', lang: 'en', canonical: `${BASE}/en/`, title: /Holiday Rental in San Teodoro/ },
];

for (const page of pages) {
  const path = join(ROOT, page.file);
  if (!existsSync(path)) {
    add(false, `${page.file} missing`);
    continue;
  }
  const html = readFileSync(path, 'utf8');
  const label = page.file;

  add(html.startsWith('<!DOCTYPE html>'), `${label}: doctype`);
  add(new RegExp(`<html lang="${page.lang}">`).test(html), `${label}: <html lang="${page.lang}">`);
  add(html.includes(`<link rel="canonical" href="${page.canonical}">`), `${label}: canonical`);
  add(page.title.test(html), `${label}: keyword-bearing <title>`);
  add(/<meta name="description" content="[^"]{80,}/.test(html), `${label}: meta description`);
  add((html.match(/<link rel="alternate" hreflang="(it|en|x-default)"/g) || []).length === 3,
    `${label}: 3 hreflang alternates`);
  add(html.includes('<meta property="og:image" content='), `${label}: og:image`);
  add(html.includes('<meta name="twitter:card"'), `${label}: twitter card`);
  add(html.includes('<link rel="icon" href="/favicon.svg"'), `${label}: favicon`);
  add(html.includes('<link rel="preload" as="image"'), `${label}: hero preload`);
  add(!/unpkg\.com|aos\.(css|js)/.test(html), `${label}: no AOS dependency`);

  // structured data must be valid JSON with the expected shape
  const ld = /<!-- jsonld:start -->([\s\S]*?)<!-- jsonld:end -->/.exec(html);
  add(!!ld, `${label}: JSON-LD block present`);
  if (ld) {
    const raw = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(ld[1]);
    let data = null;
    try {
      data = JSON.parse(raw[1]);
    } catch (err) {
      add(false, `${label}: JSON-LD does not parse (${err.message})`);
    }
    if (data) {
      add(data['@type'] === 'VacationRental', `${label}: JSON-LD @type`);
      add(data.address?.addressLocality === 'San Teodoro', `${label}: JSON-LD address`);
      add(typeof data.geo?.latitude === 'number', `${label}: JSON-LD geo`);
      add(data.inLanguage === (page.lang === 'it' ? 'it-IT' : 'en'), `${label}: JSON-LD inLanguage`);
      add(data.url === page.canonical, `${label}: JSON-LD url matches canonical`);
    }
  }

  // every content image needs intrinsic dimensions (CLS) and alt text
  const imgs = html.match(/<img [^>]*>/g) || [];
  const bad = imgs.filter((tag) => !/\bwidth="\d+"/.test(tag) || !/\bheight="\d+"/.test(tag) || !/\balt="[^"]+"/.test(tag));
  add(imgs.length >= 16 && bad.length === 0, `${label}: ${imgs.length} images all with width/height/alt`);

  add((html.match(/<details class="faq__item"/g) || []).length === 7, `${label}: 7 FAQ entries`);
  add(html.includes('id="booking-bar"'), `${label}: sticky booking bar`);
  // index.html is the source of the localized placeholders; the build resolves them for /en/
  const placeholders = (html.match(/data-placeholder-/g) || []).length;
  add(page.lang === 'it' ? placeholders === 2 : placeholders === 0,
    `${label}: localized placeholders ${page.lang === 'it' ? 'present (source)' : 'resolved'}`);
}

// the Italian-only page must be clean and the English page must have no Italian left
const itPage = readFileSync(join(ROOT, 'index.html'), 'utf8');
const enPage = readFileSync(join(ROOT, 'en/index.html'), 'utf8');
add(/class="[^"]*\bit\b[^"]*"/.test(enPage) === false, 'en/: no Italian language elements left');
add(/class="[^"]*\bit\b[^"]*"/.test(itPage), 'index.html: Italian content present');
add(/(href|src)="(css|js|images)\//.test(enPage) === false, 'en/: asset paths are root-absolute');
add(/<link rel="stylesheet" href="\/css\/style\.css">/.test(enPage), 'en/: stylesheet resolves from the root');
add(/casa vacanze/i.test(itPage) && /holiday rental/i.test(enPage), 'both pages carry their own keyword phrasing');
add(itPage.includes('data-alt-en='), 'index.html: data-alt-en present (source of the EN alt text)');

// crawl files
const robots = readFileSync(join(ROOT, 'robots.txt'), 'utf8');
add(/Sitemap: https:\/\/\S+\/sitemap\.xml/.test(robots), 'robots.txt: sitemap reference');
add(/Disallow: \/admin/.test(robots), 'robots.txt: admin disallowed');

const sitemap = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
for (const loc of [`${BASE}/`, `${BASE}/en/`]) {
  add(sitemap.includes(`<loc>${loc}</loc>`), `sitemap.xml: ${loc}`);
}
add((sitemap.match(/hreflang="x-default"/g) || []).length === 2, 'sitemap.xml: x-default on both URLs');
add((sitemap.match(/<url>/g) || []).length === 2, 'sitemap.xml: 2 URLs');

// the admin dashboard must stay out of the index
add(/name="robots" content="noindex/.test(readFileSync(join(ROOT, 'admin.html'), 'utf8')), 'admin.html: noindex');

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.message}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
