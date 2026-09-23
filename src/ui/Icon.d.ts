/**
 * Lucide glyph rendered as a currentColor mask.
 * The glyph is loaded from /icons/<name>.svg (public/icons).
 */
export interface IconProps {
  /** File stem in public/icons, e.g. "chevron-right". */
  name: string;
  /** Square px size. 16 inline, 20 default UI, 24 nav, 32+ feature. */
  size?: number;
  /** Override the tint. Defaults to currentColor. */
  strokeAccent?: string;
  style?: React.CSSProperties;
}
export declare function Icon(props: IconProps): JSX.Element;
