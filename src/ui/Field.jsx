import React from 'react';

/** Label + hint + error wrapper shared by every form control. */
export function Field({ label, hint, error, required, htmlFor, children, style, ...rest }) {
  return (
    <div {...rest} style={{ display: 'grid', gap: 'var(--space-2)', ...style }}>
      {label ? (
        <label htmlFor={htmlFor} style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--ink-2)' }}>
          {label}
          {required ? <span style={{ color: 'var(--signal-4)' }}> *</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--alert-3)' }}>{error}</span>
      ) : hint ? (
        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-muted)' }}>{hint}</span>
      ) : null}
    </div>
  );
}
