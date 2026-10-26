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

/* The open list is drawn by the browser, not inside the field. With the select itself
   transparent, Chromium on Windows paints that list on its default white while the options
   keep the field's ink, which in dark mode is near-white too. Each option says both. */
const optionStyle = { background: 'var(--surface-card)', color: 'var(--ink-1)' };

/** Native select styled like the other fields. */
export function Select({ options = [], invalid, disabled, placeholder, style, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <div style={{ ...shell(focus, invalid, disabled), position: 'relative', paddingRight: 14, ...style }}>
      <select
        {...rest} disabled={disabled}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{
          // minWidth 0: otherwise the longest option sets the select's width, and in a narrow
          // column it pushes the chevron out past the field's border. No box shadow: the
          // field around it shows focus, and the global focus ring drew a box inside it.
          flex: 1, minWidth: 0, textOverflow: 'ellipsis', appearance: 'none', border: 'none', outline: 'none', boxShadow: 'none', background: 'transparent',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body-md)', color: 'var(--ink-1)', cursor: 'pointer',
        }}
      >
        {placeholder ? <option value="" style={optionStyle}>{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value} style={optionStyle}>{o.label}</option>
        ))}
      </select>
      <span style={{ color: 'var(--text-muted)', display: 'flex', pointerEvents: 'none' }}><Icon name="chevron-down" size={18} /></span>
    </div>
  );
}
