import React from 'react';
import { Icon } from './Icon.jsx';

/** Checkbox with a soft 6px box and ink fill when checked. */
export function Checkbox({ label, description, checked, defaultChecked, disabled, onChange, style, ...rest }) {
  const [on, setOn] = React.useState(!!defaultChecked);
  const isOn = checked != null ? checked : on;
  return (
    <label
      {...rest}
      style={{ display: 'flex', gap: 12, alignItems: description ? 'flex-start' : 'center', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, ...style }}
      onClick={(e) => { if (disabled) return; e.preventDefault(); const v = !isOn; if (checked == null) setOn(v); onChange?.(v); }}
    >
      <span
        style={{
          display: 'grid', placeItems: 'center', flex: '0 0 auto', width: 22, height: 22,
          borderRadius: 'var(--radius-xs)',
          border: `1.5px solid ${isOn ? 'var(--ink-1)' : 'var(--paper-4)'}`,
          background: isOn ? 'var(--ink-1)' : 'var(--surface-card)',
          color: 'var(--paper-0)',
          transition: 'all var(--dur-fast) var(--ease-spring)',
          transform: isOn ? 'scale(1)' : 'scale(.98)',
        }}
      >
        {isOn ? <Icon name="check" size={14} /> : null}
      </span>
      <span style={{ display: 'grid', gap: 2 }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body-md)', color: 'var(--ink-1)' }}>{label}</span>
        {description ? <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-muted)' }}>{description}</span> : null}
      </span>
    </label>
  );
}
