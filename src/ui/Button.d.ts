/**
 * Primary action control.
 */
export interface ButtonProps {
  children?: React.ReactNode;
  /** primary = ink. accent = the theme colour, one per view. outline/ghost are secondary on paper. inverse and ghostInverse sit on dark or accent surfaces. */
  variant?: 'primary' | 'accent' | 'outline' | 'ghost' | 'inverse' | 'ghostInverse';
  size?: 'sm' | 'md' | 'lg';
  /** Icon name from public/icons rendered before the label. */
  iconLeft?: string;
  /** Icon name after the label. Nudges 3px right on hover. */
  iconRight?: string;
  fullWidth?: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** Render as another element, e.g. "a" for links. */
  as?: 'button' | 'a';
  href?: string;
  /** Passed through to the element; "button" keeps a button inside a form from submitting it. */
  type?: 'button' | 'submit' | 'reset';
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}
export declare function Button(props: ButtonProps): JSX.Element;
