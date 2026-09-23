/** Dropdown built on the native select. */
export interface SelectOption { value: string; label: string }
export interface SelectProps {
  options?: SelectOption[];
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  style?: React.CSSProperties;
}
export declare function Select(props: SelectProps): JSX.Element;
