/** Preview URLs in index.html become absolute on the instance that serves it (docs/operations.md). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withPublicUrl } from '../web-head.ts';

let fails = 0;
const ok = (label: string, cond: boolean) => {
  if (cond) console.log('ok  ', label);
  else { console.error('FAIL', label); fails++; }
};

const source = readFileSync(resolve(import.meta.dirname, '../../../web/index.html'), 'utf8');
const served = withPublicUrl(source, 'https://app.fabrikka.xyz/');

ok('the source names the image by a site-relative path', source.includes('property="og:image" content="/og-image.png"'));
ok('the served page names it on this instance', served.includes('property="og:image" content="https://app.fabrikka.xyz/og-image.png"'));
ok('…without a doubled slash from a trailing one in PUBLIC_URL', !served.includes('xyz//'));
ok('the canonical address is the instance', served.includes('property="og:url" content="https://app.fabrikka.xyz/"'));
ok("the card image for X too", served.includes('name="twitter:image" content="https://app.fabrikka.xyz/og-image.png"'));
ok('the structured data agrees', served.includes('"url": "https://app.fabrikka.xyz/"') && served.includes('"image": "https://app.fabrikka.xyz/og-image.png"'));
ok('nothing relative is left in the head', !/content="\//.test(served.slice(0, served.indexOf('</head>'))));
ok('a page with no preview tags passes through unchanged', withPublicUrl('<html><head></head></html>', 'https://x.example') === '<html><head></head></html>');

if (fails) process.exit(1);
