import React from 'react';

/** Hairline-bordered surface. Leans on borders, not shadow, until a card is interactive. */
export function Card({ children, tone = 'default', interactive, padding, radius, style, ...rest }) {
  const TONES = {
    default: { bg: 'var(--surface-card)', bd: 'var(--border-hairline)', fg: 'var(--text-body)' },
    sunken: { bg: 'var(--surface-sunken)', bd: 'transparent', fg: 'var(--text-body)' },
    accent: { bg: 'var(--surface-accent-soft)', bd: 'var(--signal-2)', fg: 'var(--ink-1)' },
    inverse: { bg: 'var(--surface-inverse)', bd: 'var(--border-inverse)', fg: 'var(--text-inverse)' },
  };
  const t = TONES[tone] || TONES.default;
  const [hover, setHover] = React.useState(false);
  return (
    <div
      {...rest}
      onMouseEnter={interactive ? () => setHover(true) : undefined}
      onMouseLeave={interactive ? () => setHover(false) : undefined}
      style={{
        background: t.bg,
        color: t.fg,
        border: `1px solid ${hover ? 'var(--border-strong)' : t.bd}`,
        borderRadius: radius || 'var(--radius-card)',
        padding: padding != null ? padding : 'var(--card-pad)',
        boxShadow: hover ? 'var(--shadow-2)' : 'none',
        transform: hover ? 'var(--lift-hover)' : 'none',
        transition: 'transform var(--dur-base) var(--ease-out-soft), box-shadow var(--dur-base) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard)',
        cursor: interactive ? 'pointer' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
