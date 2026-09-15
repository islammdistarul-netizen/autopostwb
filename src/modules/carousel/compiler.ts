import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import satori, { type Font } from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { log } from '../../lib/log.ts';
import { assertWritable, ensureDir, paths } from '../../lib/paths.ts';
import type { AppConfig } from '../../lib/config.ts';
import type { ProductionPayload } from '../../types/manifest.ts';
import { renderSlideElement } from './templates/index.tsx';

/**
 * Satori + Resvg rasterizer exporting PNG buffers.
 *
 * No browser in the loop: Satori lays out React elements into SVG, Resvg
 * rasterizes the SVG. Fonts are loaded once per process from assets/fonts as
 * raw buffers — the only way Satori sees Cyrillic glyphs.
 */

const CYRILLIC_PROBE = 'Съешь ещё этих мягких французских булок';

/**
 * Satori draws nothing for glyphs the loaded fonts lack — emoji and pictographs
 * would silently vanish (or throw without a loadAdditionalAsset hook). Strip
 * them so the slide never ships with invisible holes in the copy.
 */
export function stripUnrenderable(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

let fontCache: Font[] | null = null;

export function loadCarouselFonts(config: AppConfig): Font[] {
  if (fontCache) return fontCache;
  const fonts: Font[] = [];
  for (const spec of config.carousel.fonts) {
    const file = path.join(paths.fonts, spec.file);
    if (!fs.existsSync(file)) {
      throw new Error(`Font missing: ${file}. Run scripts/setup-server.sh to download Inter + Unbounded.`);
    }
    fonts.push({
      name: spec.name,
      data: fs.readFileSync(file),
      weight: spec.weight as Font['weight'],
      style: spec.style,
    });
  }
  fontCache = fonts;
  return fonts;
}

export interface CompiledSlide {
  index: number;
  pngPath: string;
  svgBytes: number;
  pngBytes: number;
}

export interface CompileOptions {
  outDir?: string;
  brandHandle?: string;
  /** Also keep the intermediate SVG next to the PNG (debugging layout). */
  keepSvg?: boolean;
}

export async function renderSlideToPng(
  manifest: ProductionPayload,
  slideIndex: number,
  config: AppConfig,
  options: CompileOptions = {},
): Promise<{ png: Buffer; svg: string }> {
  const slide = manifest.carouselConfig.slides.find((s) => s.index === slideIndex);
  if (!slide) throw new Error(`Slide ${slideIndex} is not in the manifest`);

  const element = renderSlideElement({
    slide: {
      ...slide,
      tag: slide.tag ? stripUnrenderable(slide.tag) : slide.tag,
      headline: stripUnrenderable(slide.headline),
      content: stripUnrenderable(slide.content),
      accentPhrase: slide.accentPhrase ? stripUnrenderable(slide.accentPhrase) : slide.accentPhrase,
    },
    theme: manifest.carouselConfig.theme,
    total: manifest.carouselConfig.slides.length,
    brandHandle: options.brandHandle ?? '',
  });

  const svg = await satori(element, {
    width: config.carousel.width,
    height: config.carousel.height,
    fonts: loadCarouselFonts(config),
    embedFont: true,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: config.carousel.width },
    background: manifest.carouselConfig.theme.backgroundColor,
  });
  const png = Buffer.from(resvg.render().asPng());
  return { png, svg };
}

export async function compileCarousel(
  manifest: ProductionPayload,
  config: AppConfig,
  options: CompileOptions = {},
): Promise<CompiledSlide[]> {
  const outDir = assertWritable(options.outDir ?? paths.carouselOut);
  ensureDir(outDir);

  // Stale slides from a longer previous run must not ride along into Postiz.
  for (const f of fs.readdirSync(outDir)) {
    if (/^slide_\d+\.(png|svg)$/.test(f)) fs.unlinkSync(path.join(outDir, f));
  }

  const slides = [...manifest.carouselConfig.slides].sort((a, b) => a.index - b.index);
  log.step(`Carousel: compiling ${slides.length} slide(s) via Satori + Resvg`);

  const compiled: CompiledSlide[] = [];
  for (const slide of slides) {
    const { png, svg } = await renderSlideToPng(manifest, slide.index, config, options);
    const pngPath = path.join(outDir, `slide_${slide.index}.png`);
    fs.writeFileSync(pngPath, png);
    if (options.keepSvg) fs.writeFileSync(pngPath.replace(/\.png$/, '.svg'), svg, 'utf8');
    compiled.push({ index: slide.index, pngPath, svgBytes: Buffer.byteLength(svg), pngBytes: png.length });
    log.info('slide rendered', { index: slide.index, kb: Math.round(png.length / 1024) });
  }
  return compiled;
}

/** Sanity check used by `doctor`: does every configured font actually shape Cyrillic? */
export async function verifyCyrillicFonts(config: AppConfig): Promise<string[]> {
  const problems: string[] = [];
  const fonts = loadCarouselFonts(config);
  for (const font of fonts) {
    try {
      const svg = await satori(
        createElement('div', { style: { display: 'flex', fontFamily: font.name, fontSize: 32 } }, CYRILLIC_PROBE),
        { width: 1080, height: 100, fonts: [font] },
      );
      // Satori draws missing glyphs as empty paths — a Cyrillic-capable font yields real path data.
      if (!svg.includes('<path')) problems.push(`${font.name} (${font.weight}) rendered no glyphs for Cyrillic`);
    } catch (err) {
      problems.push(`${font.name}: ${(err as Error).message}`);
    }
  }
  return problems;
}
