import React from 'react';
import type { CarouselSlideData, CarouselTheme } from '../../../types/manifest.ts';
import {
  accentBlockStyle,
  bodyStyle,
  fitBody,
  fitHeadline,
  footerStyle,
  headlineStyle,
  pageStyle,
  tagStyle,
  withAlpha,
} from '../styles.ts';

/**
 * Card templates: Hook Slide (first), Point Slide (middle), Summary Slide (last).
 *
 * These are plain React elements consumed by Satori — no hooks, no state, no
 * browser APIs. Text is drawn exactly as the manifest supplies it.
 */

export interface SlideContext {
  slide: CarouselSlideData;
  theme: CarouselTheme;
  total: number;
  brandHandle: string;
}

export type SlideKind = 'hook' | 'point' | 'summary';

export function slideKind(index: number, total: number): SlideKind {
  if (index <= 1) return 'hook';
  if (index >= total) return 'summary';
  return 'point';
}

const Footer: React.FC<{ ctx: SlideContext; hint: string }> = ({ ctx, hint }) => (
  <div style={footerStyle(ctx.theme)}>
    <span>{ctx.brandHandle}</span>
    <span>{hint}</span>
    <span>{`${ctx.slide.index} / ${ctx.total}`}</span>
  </div>
);

const Tag: React.FC<{ ctx: SlideContext; fallback: string }> = ({ ctx, fallback }) => (
  <div style={tagStyle(ctx.theme)}>{ctx.slide.tag ?? fallback}</div>
);

export const HookSlide: React.FC<SlideContext> = (ctx) => {
  const { slide, theme } = ctx;
  return (
    <div style={pageStyle(theme)}>
      <Tag ctx={ctx} fallback="Сохрани" />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={headlineStyle(fitHeadline(slide.headline))}>{slide.headline}</div>
        {slide.content ? (
          <div style={{ ...bodyStyle(fitBody(slide.content), withAlpha(theme.primaryTextColor, 0.8)), marginTop: 36 }}>
            {slide.content}
          </div>
        ) : null}
        {slide.accentPhrase ? (
          <div style={{ ...accentBlockStyle(theme), marginTop: 48, alignSelf: 'flex-start' }}>{slide.accentPhrase}</div>
        ) : null}
      </div>
      <Footer ctx={ctx} hint="листай →" />
    </div>
  );
};

export const PointSlide: React.FC<SlideContext> = (ctx) => {
  const { slide, theme } = ctx;
  return (
    <div style={pageStyle(theme)}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
        <div
          style={{
            display: 'flex',
            width: 92,
            height: 92,
            borderRadius: 24,
            backgroundColor: theme.accentColor,
            color: theme.backgroundColor,
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'Unbounded',
            fontWeight: 600,
            fontSize: 44,
          }}
        >
          {String(slide.index - 1).padStart(2, '0')}
        </div>
        {slide.tag ? <div style={{ ...tagStyle(theme), marginLeft: 24 }}>{slide.tag}</div> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={headlineStyle(Math.min(fitHeadline(slide.headline), 72))}>{slide.headline}</div>
        <div style={{ ...bodyStyle(fitBody(slide.content), withAlpha(theme.primaryTextColor, 0.86)), marginTop: 34 }}>
          {slide.content}
        </div>
        {slide.accentPhrase ? (
          <div
            style={{
              display: 'flex',
              marginTop: 40,
              paddingLeft: 28,
              borderLeft: `8px solid ${theme.accentColor}`,
              fontFamily: 'Inter',
              fontWeight: 700,
              fontSize: 40,
              lineHeight: 1.3,
              color: theme.accentColor,
            }}
          >
            {slide.accentPhrase}
          </div>
        ) : null}
      </div>
      <Footer ctx={ctx} hint="листай →" />
    </div>
  );
};

export const SummarySlide: React.FC<SlideContext> = (ctx) => {
  const { slide, theme } = ctx;
  return (
    <div style={pageStyle(theme)}>
      <Tag ctx={ctx} fallback="Итог" />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={headlineStyle(Math.min(fitHeadline(slide.headline), 80))}>{slide.headline}</div>
        <div style={{ ...bodyStyle(fitBody(slide.content), withAlpha(theme.primaryTextColor, 0.86)), marginTop: 34 }}>
          {slide.content}
        </div>
        <div style={{ ...accentBlockStyle(theme), marginTop: 52 }}>
          {slide.accentPhrase ?? 'Сохрани, чтобы не потерять. Подпишись — дальше будет ещё полезнее.'}
        </div>
      </div>
      <Footer ctx={ctx} hint="сохрани ✓" />
    </div>
  );
};

export function renderSlideElement(ctx: SlideContext): React.ReactElement {
  switch (slideKind(ctx.slide.index, ctx.total)) {
    case 'hook':
      return <HookSlide {...ctx} />;
    case 'summary':
      return <SummarySlide {...ctx} />;
    default:
      return <PointSlide {...ctx} />;
  }
}
