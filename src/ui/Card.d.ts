/** Surface container: hairline border, 18px radius, warm white. */
export interface CardProps {
  children?: React.ReactNode;
  tone?: 'default' | 'sunken' | 'accent' | 'inverse';
  /** Adds hover lift, ink border and shadow. Use only when the whole card is clickable. */
  interactive?: boolean;
  padding?: number | string;
  radius?: string;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}
export declare function Card(props: CardProps): JSX.Element;
