/** Single-line text input. */
export interface InputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'size' | 'style' | 'onChange'
  > {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  type?: string;
  size?: 'sm' | 'md';
  iconLeft?: string;
  iconRight?: string;
  invalid?: boolean;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  style?: React.CSSProperties;
}
export declare function Input(props: InputProps): JSX.Element;
