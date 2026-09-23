import React from 'react';
import { Icon } from './Icon.jsx';

const SIZES = {
  sm: { h: 'var(--control-height-sm)', px: 18, fs: 'var(--text-body-sm)', gap: 7, icon: 16 },
  md: { h: 'var(--control-height)', px: 26, fs: 'var(--text-body-md)', gap: 9, icon: 18 },
  lg: { h: 60, px: 34, fs: 'var(--text-body-lg)', gap: 10, icon: 20 },
};

const VARIANTS = {
  primary: { bg: 'var(--ink-1)', fg: 'var(--text-inverse)', bd: 'var(--ink-1)', hoverBg: 'var(--ink-2)' },
  accent: { bg: 'var(--signal-3)', fg: 'var(--paper-0)', bd: 'var(--signal-3)', hoverBg: 'var(--signal-4)' },
  outline: { bg: 'transparent', fg: 'var(--ink-1)', bd: 'var(--ink-1)', hoverBg: 'var(--paper-2)' },
  ghost: { bg: 'transparent', fg: 'var(--ink-2)', bd: 'transparent', hoverBg: 'var(--paper-2)' },
  inverse: { bg: 'var(--paper-0)', fg: 'var(--ink-1)', bd: 'var(--paper-0)', hoverBg: 'var(--paper-2)' },
  ghostInverse: { bg: 'transparent', fg: 'var(--paper-0)', bd: 'rgba(255,253,250,.4)', hoverBg: 'rgba(255,253,250,.16)' },
};

/** Action control: pill, one weight of type, motion on hover and press. */
export function Button({
  children, variant = 'primary', size = 'md', iconLeft, iconRight,
  fullWidth, disabled, loading, as = 'button', style, ...rest
}) {
  const s = SIZES[size] || SIZES.md;
  const v = VARIANTS[variant] || VARIANTS.primary;
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const El = as;
  return (
    <El
      {...rest}
      disabled={El === 'button' ? disabled || loading : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPress(false); }}
      onMouseDown={() => setPress(true)}
      onMouseUp={() => setPress(false)}
      style={{
        display: fullWidth ? 'flex' : 'inline-flex',
        width: fullWidth ? '100%' : undefined,
        alignItems: 'center',
        justifyContent: 'center',
        gap: s.gap,
        height: s.h,
        padding: `0 ${s.px}px`,
        borderRadius: 'var(--radius-control)',
        border: `1px solid ${v.bd}`,
        background: hover && !disabled ? v.hoverBg : v.bg,
        color: v.fg,
        fontFamily: 'var(--font-sans)',
        fontSize: s.fs,
        fontWeight: 'var(--weight-semibold)',
        letterSpacing: '-0.005em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        textDecoration: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        boxShadow: hover && !disabled && variant !== 'ghost' ? 'var(--shadow-2)' : 'none',
        transform: press && !disabled ? `scale(var(--press-scale))` : hover && !disabled ? 'var(--lift-hover)' : 'none',
        transition: 'background var(--dur-fast) var(--ease-standard), transform var(--dur-fast) var(--ease-standard), box-shadow var(--dur-base) var(--ease-standard), color var(--dur-fast) var(--ease-standard)',
        ...style,
      }}
    >
      {iconLeft ? <Icon name={iconLeft} size={s.icon} /> : null}
      <span style={{ opacity: loading ? 0.55 : 1 }}>{children}</span>
      {iconRight ? (
        <Icon name={iconRight} size={s.icon} style={{ transform: hover ? 'translateX(3px)' : 'none', transition: 'transform var(--dur-base) var(--ease-out-soft)' }} />
      ) : null}
    </El>
  );
}
