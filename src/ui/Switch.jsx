import React from 'react';

/** Instant-effect toggle. Never use it where a save button is required. */
export function Switch({ checked, defaultChecked, disabled, label, onChange, style, ...rest }) {
  const [on, setOn] = React.useState(!!defaultChecked);
  const isOn = checked != null ? checked : on;
  return (
    <label
      {...rest}
      onClick={() => { if (disabled) return; const v = !isOn; if (checked == null) setOn(v); onChange?.(v); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 12, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, ...style }}
    >
      <span
        style={{
          position: 'relative', width: 46, height: 28, borderRadius: 999, flex: '0 0 auto',
          // A theme can colour the on state; ink is the default so untouched themes are unchanged.
          background: isOn ? 'var(--switch-on, var(--ink-1))' : 'var(--paper-4)',
          transition: 'background var(--dur-base) var(--ease-standard)',
        }}
      >
        <span
          style={{
            position: 'absolute', top: 3, left: isOn ? 21 : 3, width: 22, height: 22, borderRadius: 999,
            background: 'var(--paper-0)', boxShadow: 'var(--shadow-1)',
            transition: 'left var(--dur-base) var(--ease-spring)',
          }}
        />
      </span>
      {label ? <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body-md)', color: 'var(--ink-1)' }}>{label}</span> : null}
    </label>
  );
}
