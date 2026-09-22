// Renders intent/icons/app-icon.svg to public/icons/icon-192.png and icon-512.png.
// public/icons/ is git-ignored and generated at build time (see package.json "icons" script).
// Idempotent: re-running overwrites the same two files with the same content.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const sourceSvgPath = join(repoRoot, 'intent/icons/app-icon.svg');
const outDir = join(repoRoot, 'public/icons');

const sizes = [192, 512];

function renderIcon(svg, size, outPath) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  const rendered = resvg.render();
  writeFileSync(outPath, rendered.asPng());
}

function main() {
  const svg = readFileSync(sourceSvgPath, 'utf8');
  mkdirSync(outDir, { recursive: true });

  for (const size of sizes) {
    const outPath = join(outDir, `icon-${size}.png`);
    renderIcon(svg, size, outPath);
    console.log(`wrote ${outPath}`);
  }
}

main();
