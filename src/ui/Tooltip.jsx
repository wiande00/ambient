import React from 'react';

/** Hover explanation for a measure or a locked control. */
export function Tooltip({ label, children, placement = 'top', style, labelStyle, ...rest }) {
  const [open, setOpen] = React.useState(false);
  const pos = {
    top: { bottom: '100%', left: '50%', transform: 'translate(-50%,-8px)' },
    bottom: { top: '100%', left: '50%', transform: 'translate(-50%,8px)' },
    right: { left: '100%', top: '50%', transform: 'translate(8px,-50%)' },
    left: { right: '100%', top: '50%', transform: 'translate(-8px,-50%)' },
  }[placement];
  return (
    <span
      {...rest}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
      style={{ position: 'relative', display: 'inline-flex', ...style }}
    >
      {children}
      <span
        role="tooltip"
        style={{
          position: 'absolute', zIndex: 40, ...pos,
          padding: '8px 12px', borderRadius: 'var(--radius-sm)',
          background: 'var(--ink-1)', color: 'var(--paper-0)',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-caption)', lineHeight: 1.4,
          whiteSpace: 'nowrap', pointerEvents: 'none',
          opacity: open ? 1 : 0,
          transition: 'opacity var(--dur-fast) var(--ease-standard)',
          // Last, so a caller with a long label can let it wrap inside a max width.
          ...labelStyle,
        }}
      >
        {label}
      </span>
    </span>
  );
}
