import type { CarouselTheme } from '../../types/manifest.ts';

/**
 * Strict Flexbox layouts and typography tokens for Satori.
 *
 * Satori implements a subset of CSS: flexbox, absolute positioning, borders,
 * gradients, text. No grid, no floats, no `gap` shorthand surprises. Every
 * style object below stays inside that subset on purpose.
 */

export const CANVAS = { width: 1080, height: 1350 } as const;
export const SAFE = { x: 84, top: 96, bottom: 120 } as const;

export const type = {
  display: { fontFamily: 'Unbounded', fontWeight: 600 as const },
  body: { fontFamily: 'Inter', fontWeight: 400 as const },
  bold: { fontFamily: 'Inter', fontWeight: 700 as const },
} as const;

export function pageStyle(theme: CarouselTheme): Record<string, string | number> {
  return {
    width: CANVAS.width,
    height: CANVAS.height,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    paddingLeft: SAFE.x,
    paddingRight: SAFE.x,
    paddingTop: SAFE.top,
    paddingBottom: SAFE.bottom,
    backgroundColor: theme.backgroundColor,
    color: theme.primaryTextColor,
    fontFamily: theme.fontFamily,
  };
}

export function tagStyle(theme: CarouselTheme): Record<string, string | number> {
  return {
    display: 'flex',
    alignSelf: 'flex-start',
    paddingLeft: 22,
    paddingRight: 22,
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: 999,
    border: `3px solid ${theme.accentColor}`,
    color: theme.accentColor,
    fontFamily: 'Inter',
    fontWeight: 700,
    fontSize: 30,
    letterSpacing: 2,
    textTransform: 'uppercase',
  };
}

export const headlineStyle = (size: number): Record<string, string | number> => ({
  display: 'flex',
  ...type.display,
  fontSize: size,
  lineHeight: 1.12,
  letterSpacing: -1,
});

export const bodyStyle = (size: number, color: string): Record<string, string | number> => ({
  display: 'flex',
  ...type.body,
  fontSize: size,
  lineHeight: 1.38,
  color,
});

export function accentBlockStyle(theme: CarouselTheme): Record<string, string | number> {
  return {
    display: 'flex',
    paddingLeft: 30,
    paddingRight: 30,
    paddingTop: 26,
    paddingBottom: 26,
    borderRadius: 24,
    backgroundColor: theme.accentColor,
    color: theme.backgroundColor,
    ...type.bold,
    fontSize: 40,
    lineHeight: 1.25,
  };
}

export function footerStyle(theme: CarouselTheme): Record<string, string | number> {
  return {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    ...type.bold,
    fontSize: 28,
    color: withAlpha(theme.primaryTextColor, 0.55),
  };
}

/** Satori accepts rgba(); this keeps theme colors usable at reduced opacity. */
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Headline size that keeps Cyrillic text on <= 4 lines across the safe width. */
export function fitHeadline(text: string): number {
  const len = text.length;
  if (len <= 28) return 92;
  if (len <= 44) return 78;
  if (len <= 64) return 66;
  if (len <= 90) return 56;
  return 48;
}

export function fitBody(text: string): number {
  const len = text.length;
  if (len <= 140) return 46;
  if (len <= 240) return 42;
  if (len <= 360) return 38;
  return 34;
}
