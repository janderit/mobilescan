// Renders site/index.template.html to site/index.html, filling the {{IMPRINT_*}}
// placeholders (name, address, contact data for the Impressum) from the git-ignored
// .env in the repo root, so the personal data never enters the repository.
// site/index.html is git-ignored and generated at build time (see package.json "site" script).
// Without a .env the placeholders from .env.example are used and a warning is printed.
// It also fills {{QR_SVG}} with an inline SVG QR code of the app URL, which the hero shows
// instead of the "open the app" button on desktop browsers (see the template's CSS).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const templatePath = join(repoRoot, 'site/index.template.html');
const outPath = join(repoRoot, 'site/index.html');
const envPath = join(repoRoot, '.env');
const envExamplePath = join(repoRoot, '.env.example');

// Encoded into the desktop QR code; the PWA is served at this fixed address (see deploy.sh).
const APP_URL = 'https://mobilescan.app/app/';

const KEYS = [
  'IMPRINT_NAME',
  'IMPRINT_BUSINESS',
  'IMPRINT_STREET',
  'IMPRINT_CITY',
  'IMPRINT_PHONE',
  'IMPRINT_EMAIL',
  'IMPRINT_VAT_ID',
];

// Minimal .env parser: KEY=value lines, optional single or double quotes, # comments.
function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(["'])(.*)\1$/);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
    values[key] = value;
  }
  return values;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let source = envPath;
if (!existsSync(envPath)) {
  console.warn(`render-site: ${envPath} not found; using placeholders from .env.example.`);
  source = envExamplePath;
}
const env = parseEnv(readFileSync(source, 'utf8'));

const missing = KEYS.filter((key) => !env[key]);
if (missing.length > 0) {
  console.error(`render-site: missing in ${source}: ${missing.join(', ')} (see .env.example).`);
  process.exit(1);
}

const values = Object.fromEntries(KEYS.map((key) => [key, escapeHtml(env[key])]));
values.YEAR = String(new Date().getFullYear());
// Modules on currentColor, background from the page CSS; the encoder's own white square is dropped.
values.QR_SVG = (
  await QRCode.toString(APP_URL, { type: 'svg', errorCorrectionLevel: 'M', margin: 0 })
)
  .replace(/<path fill="#ffffff"[^>]*\/>/, '')
  .replace('stroke="#000000"', 'stroke="currentColor"')
  .replace('<svg ', '<svg aria-hidden="true" ');

const template = readFileSync(templatePath, 'utf8');
const unknown = new Set();
const html = template
  .replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (key in values) return values[key];
    unknown.add(key);
    return match;
  })
  .replace(
    '<!doctype html>',
    '<!doctype html>\n<!-- Generated from site/index.template.html by scripts/render-site.mjs; do not edit. -->',
  );

if (unknown.size > 0) {
  console.error(`render-site: unknown placeholders in template: ${[...unknown].join(', ')}`);
  process.exit(1);
}

writeFileSync(outPath, html);
console.log(`render-site: wrote ${outPath} (contact data from ${source}).`);
