// Renders intent/icons/app-icon.svg to public/icons/icon-192.png, icon-512.png and
// icon-maskable-512.png (the artwork scaled into the maskable safe zone on a
// full-bleed background, so launchers may clip it to any shape).
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

// Maskable icons must keep their content inside the central 80 % (the safe zone);
// scale the artwork to 75 % and centre it on the icon's own background colour.
const MASKABLE_SCALE = 0.75;
const MASKABLE_BACKGROUND = '#1e40af';

function maskableSvg(svg) {
  const open = svg.match(/<svg[^>]*>/);
  if (!open) throw new Error('app-icon.svg: no <svg> element');
  const inner = svg.slice(open.index + open[0].length).replace(/<\/svg>\s*$/, '');
  const offset = (512 * (1 - MASKABLE_SCALE)) / 2;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">' +
    `<rect width="512" height="512" fill="${MASKABLE_BACKGROUND}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${MASKABLE_SCALE})">${inner}</g>` +
    '</svg>'
  );
}

function main() {
  const svg = readFileSync(sourceSvgPath, 'utf8');
  mkdirSync(outDir, { recursive: true });

  for (const size of sizes) {
    const outPath = join(outDir, `icon-${size}.png`);
    renderIcon(svg, size, outPath);
    console.log(`wrote ${outPath}`);
  }
  const maskablePath = join(outDir, 'icon-maskable-512.png');
  renderIcon(maskableSvg(svg), 512, maskablePath);
  console.log(`wrote ${maskablePath}`);
}

main();
