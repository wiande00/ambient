import React from 'react';

// An absolute path: a relative one would resolve against the current route and 404 on
// every page but the root.
const BASE = '/icons';

/** Masked Lucide glyph. Inherits currentColor, so it tints with its parent text. */
export function Icon({ name, size = 20, strokeAccent, style, ...rest }) {
  const url = `${BASE}/${name}.svg`;
  return (
    <span
      aria-hidden="true"
      {...rest}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flex: '0 0 auto',
        background: strokeAccent || 'currentColor',
        // Masked elements repaint on every scroll frame unless promoted to their own
        // compositing layer — a page can easily carry a few dozen icons, and that adds
        // up to visible scroll jank without this.
        transform: 'translateZ(0)',
        WebkitMaskImage: `url("${url}")`,
        maskImage: `url("${url}")`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        ...style,
      }}
    />
  );
}
