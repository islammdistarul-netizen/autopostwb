/**
 * Generates a complete placeholder sprite set for assets/characters/<id> so the
 * pipeline renders end-to-end before real artwork exists. Flat vector shapes,
 * rasterized with Resvg — no AI image generation anywhere.
 *
 *   npx tsx scripts/make-placeholder-sprites.ts [characterId=default] [--force]
 *
 * Replace the PNGs with real art later; keep the filenames from character.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const characterId = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'default';
const force = process.argv.includes('--force');
const dir = path.join(ROOT, 'assets', 'characters', characterId);
const character = JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8')) as {
  layers: {
    bodies: Record<string, string>;
    faces: Record<string, string>;
    mouths: Record<string, string>;
  };
};

const SKIN = '#F2C9A6';
const SHIRT = '#2F6DF6';
const DARK = '#1B1F27';
const LIP = '#B8503F';
const TEETH = '#FFFFFF';

function png(svg: string, outFile: string): void {
  if (fs.existsSync(outFile) && !force) return;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(new Resvg(svg).render().asPng()));
  process.stderr.write(`wrote ${path.relative(ROOT, outFile)}\n`);
}

// ---------------------------------------------------------------------------
// Bodies: 720x960, head at top center (face + mouth layers sit over it)
// ---------------------------------------------------------------------------
const BODY_W = 720;
const BODY_H = 960;

function body(pose: string): string {
  const arms: Record<string, string> = {
    idle: `<rect x="120" y="560" width="80" height="300" rx="40" fill="${SHIRT}"/><rect x="520" y="560" width="80" height="300" rx="40" fill="${SHIRT}"/>`,
    pointing: `<rect x="120" y="560" width="80" height="300" rx="40" fill="${SHIRT}"/><g transform="rotate(-55 560 590)"><rect x="520" y="560" width="80" height="320" rx="40" fill="${SHIRT}"/><circle cx="560" cy="880" r="52" fill="${SKIN}"/></g>`,
    thinking: `<rect x="120" y="560" width="80" height="300" rx="40" fill="${SHIRT}"/><g transform="rotate(-120 560 590)"><rect x="520" y="560" width="80" height="260" rx="40" fill="${SHIRT}"/><circle cx="560" cy="820" r="52" fill="${SKIN}"/></g>`,
    shocked: `<g transform="rotate(35 160 590)"><rect x="120" y="560" width="80" height="300" rx="40" fill="${SHIRT}"/><circle cx="160" cy="860" r="52" fill="${SKIN}"/></g><g transform="rotate(-35 560 590)"><rect x="520" y="560" width="80" height="300" rx="40" fill="${SHIRT}"/><circle cx="560" cy="860" r="52" fill="${SKIN}"/></g>`,
    hands_on_hips: `<path d="M160 580 L60 720 L200 800 L230 760 L150 710 L220 620 Z" fill="${SHIRT}"/><path d="M560 580 L660 720 L520 800 L490 760 L570 710 L500 620 Z" fill="${SHIRT}"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BODY_W}" height="${BODY_H}" viewBox="0 0 ${BODY_W} ${BODY_H}">
  <rect x="200" y="540" width="320" height="420" rx="90" fill="${SHIRT}"/>
  ${arms[pose] ?? arms.idle}
  <rect x="300" y="440" width="120" height="140" rx="40" fill="${SKIN}"/>
  <ellipse cx="360" cy="300" rx="190" ry="220" fill="${SKIN}"/>
  <path d="M170 260 Q360 20 550 260 Q470 130 360 140 Q250 130 170 260 Z" fill="${DARK}"/>
</svg>`;
}

// ---------------------------------------------------------------------------
// Faces: 380x260 eye/brow region (transparent background)
// ---------------------------------------------------------------------------
function face(mood: string): string {
  const eyes: Record<string, string> = {
    neutral: `<circle cx="120" cy="150" r="26" fill="${DARK}"/><circle cx="260" cy="150" r="26" fill="${DARK}"/><path d="M80 90 Q120 70 160 90" stroke="${DARK}" stroke-width="12" fill="none" stroke-linecap="round"/><path d="M220 90 Q260 70 300 90" stroke="${DARK}" stroke-width="12" fill="none" stroke-linecap="round"/>`,
    happy: `<path d="M90 160 Q120 120 150 160" stroke="${DARK}" stroke-width="14" fill="none" stroke-linecap="round"/><path d="M230 160 Q260 120 290 160" stroke="${DARK}" stroke-width="14" fill="none" stroke-linecap="round"/><path d="M80 80 Q120 60 160 80" stroke="${DARK}" stroke-width="12" fill="none" stroke-linecap="round"/><path d="M220 80 Q260 60 300 80" stroke="${DARK}" stroke-width="12" fill="none" stroke-linecap="round"/>`,
    skeptical: `<circle cx="120" cy="150" r="22" fill="${DARK}"/><circle cx="260" cy="150" r="26" fill="${DARK}"/><path d="M80 110 L160 95" stroke="${DARK}" stroke-width="12" stroke-linecap="round"/><path d="M220 70 Q260 55 300 85" stroke="${DARK}" stroke-width="12" fill="none" stroke-linecap="round"/>`,
    surprised: `<circle cx="120" cy="150" r="34" fill="${DARK}"/><circle cx="260" cy="150" r="34" fill="${DARK}"/><circle cx="130" cy="138" r="9" fill="#fff"/><circle cx="270" cy="138" r="9" fill="#fff"/><path d="M80 60 Q120 35 160 60" stroke="${DARK}" stroke-width="12" fill="none" stroke-linecap="round"/><path d="M220 60 Q260 35 300 60" stroke="${DARK}" stroke-width="12" fill="none" stroke-linecap="round"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="260" viewBox="0 0 380 260">${eyes[mood] ?? eyes.neutral}</svg>`;
}

// ---------------------------------------------------------------------------
// Mouths: 200x120, Rhubarb shapes A-F, X (rest) and closed
// ---------------------------------------------------------------------------
function mouth(shape: string): string {
  const shapes: Record<string, string> = {
    // A: closed, lips pressed (m, b, p)
    A: `<path d="M50 62 Q100 74 150 62" stroke="${LIP}" stroke-width="12" fill="none" stroke-linecap="round"/>`,
    // B: slightly open, teeth visible (most consonants)
    B: `<path d="M40 55 Q100 40 160 55 Q100 90 40 55 Z" fill="${LIP}"/><rect x="62" y="56" width="76" height="14" rx="4" fill="${TEETH}"/>`,
    // C: open (e, ae)
    C: `<ellipse cx="100" cy="62" rx="58" ry="30" fill="${LIP}"/><ellipse cx="100" cy="66" rx="40" ry="18" fill="${DARK}"/><rect x="66" y="42" width="68" height="12" rx="4" fill="${TEETH}"/>`,
    // D: wide open (a)
    D: `<ellipse cx="100" cy="62" rx="62" ry="44" fill="${LIP}"/><ellipse cx="100" cy="68" rx="46" ry="30" fill="${DARK}"/>`,
    // E: rounded, slightly open (o, er)
    E: `<ellipse cx="100" cy="62" rx="40" ry="34" fill="${LIP}"/><ellipse cx="100" cy="64" rx="26" ry="22" fill="${DARK}"/>`,
    // F: puckered (u, w)
    F: `<ellipse cx="100" cy="62" rx="26" ry="26" fill="${LIP}"/><ellipse cx="100" cy="62" rx="14" ry="14" fill="${DARK}"/>`,
    // X: rest
    X: `<path d="M56 64 Q100 70 144 64" stroke="${LIP}" stroke-width="10" fill="none" stroke-linecap="round"/>`,
    closed: `<path d="M56 64 Q100 70 144 64" stroke="${LIP}" stroke-width="10" fill="none" stroke-linecap="round"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">${shapes[shape] ?? shapes.X}</svg>`;
}

// Eyes-closed overlay for the deterministic blink schedule (same canvas as faces).
function blinkOverlay(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="260" viewBox="0 0 380 260">
  <ellipse cx="120" cy="150" rx="34" ry="30" fill="${SKIN}"/><ellipse cx="260" cy="150" rx="34" ry="30" fill="${SKIN}"/>
  <path d="M90 152 Q120 168 150 152" stroke="${DARK}" stroke-width="10" fill="none" stroke-linecap="round"/>
  <path d="M230 152 Q260 168 290 152" stroke="${DARK}" stroke-width="10" fill="none" stroke-linecap="round"/>
</svg>`;
}

const { bodies, faces, mouths, blink } = character.layers as typeof character.layers & {
  blink?: { dir: string; file: string };
};
if (blink) png(blinkOverlay(), path.join(dir, blink.dir, blink.file));
for (const [key, file] of Object.entries(bodies)) {
  if (key === 'dir') continue;
  png(body(key), path.join(dir, bodies.dir!, file));
}
for (const [key, file] of Object.entries(faces)) {
  if (['dir', 'offset', 'scale'].includes(key)) continue;
  png(face(key), path.join(dir, faces.dir!, file));
}
for (const [key, file] of Object.entries(mouths)) {
  if (['dir', 'offset', 'scale'].includes(key)) continue;
  png(mouth(key), path.join(dir, mouths.dir!, file));
}
process.stderr.write(`placeholder sprites ready in ${path.relative(ROOT, dir)}\n`);
