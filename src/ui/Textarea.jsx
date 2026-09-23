import React from 'react';

/** Multi-line text input. */
export function Textarea({ rows = 5, invalid, disabled, style, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <textarea
      {...rest} rows={rows} disabled={disabled}
      onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }}
      onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
      style={{
        width: '100%', padding: '14px 18px', resize: 'vertical',
        borderRadius: 'var(--radius-field)',
        border: `1px solid ${invalid ? 'var(--alert-3)' : focus ? 'var(--ink-1)' : 'var(--border-hairline)'}`,
        boxShadow: focus && !invalid ? 'var(--shadow-focus)' : 'none',
        background: disabled ? 'var(--paper-2)' : 'var(--surface-card)',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body-md)',
        lineHeight: 'var(--leading-body)', color: 'var(--ink-1)', outline: 'none',
        transition: 'border-color var(--dur-fast) var(--ease-standard), box-shadow var(--dur-fast) var(--ease-standard)',
        ...style,
      }}
    />
  );
}
