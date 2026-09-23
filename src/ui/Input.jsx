import React from 'react';
import { Icon } from './Icon.jsx';

const shell = (focus, invalid, disabled) => ({
  display: 'flex', alignItems: 'center', gap: 10,
  height: 'var(--field-height)', padding: '0 18px',
  borderRadius: 'var(--radius-field)',
  background: disabled ? 'var(--paper-2)' : 'var(--surface-card)',
  border: `1px solid ${invalid ? 'var(--alert-3)' : focus ? 'var(--ink-1)' : 'var(--border-hairline)'}`,
  boxShadow: focus && !invalid ? 'var(--shadow-focus)' : 'none',
  transition: 'border-color var(--dur-fast) var(--ease-standard), box-shadow var(--dur-fast) var(--ease-standard)',
});

/** Text input. 18px radius, hairline border, ink border on focus. */
export function Input({ iconLeft, iconRight, invalid, disabled, size = 'md', style, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <div style={{ ...shell(focus, invalid, disabled), height: size === 'sm' ? 'var(--field-height-sm)' : 'var(--field-height)', ...style }}>
      {iconLeft ? <span style={{ color: 'var(--text-muted)', display: 'flex' }}><Icon name={iconLeft} size={18} /></span> : null}
      <input
        {...rest} disabled={disabled}
        onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }}
        onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
        style={{
          flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
          font: 'inherit', fontFamily: 'var(--font-sans)',
          fontSize: size === 'sm' ? 'var(--text-body-sm)' : 'var(--text-body-md)',
          color: 'var(--ink-1)',
        }}
      />
      {iconRight ? <span style={{ color: 'var(--text-muted)', display: 'flex' }}><Icon name={iconRight} size={18} /></span> : null}
    </div>
  );
}
