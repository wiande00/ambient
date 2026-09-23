/**
 * Hover-only explanation. Never put actions inside.
 *
 * Hover-only is literal: `Tooltip.jsx` opens on `onMouseEnter` alone, so the label is
 * unreachable by keyboard and invisible to assistive tech. A caller that needs the content
 * to be available without a mouse has to put it on the wrapped element itself — see
 * `DayBand`, which mirrors each label into an `aria-label`.
 */
export interface TooltipProps {
  /**
   * Rendered as a child, so any node works — this was declared as `string`, which was
   * narrower than the component, and rejected the multi-line labels it renders correctly.
   */
  label: React.ReactNode;
  children?: React.ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  style?: React.CSSProperties;
  /** Overrides on the popup itself, e.g. to let a long label wrap. */
  labelStyle?: React.CSSProperties;
}
export declare function Tooltip(props: TooltipProps): JSX.Element;
