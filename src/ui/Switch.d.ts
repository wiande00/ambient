/** Immediate-effect toggle. */
export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  /** Rendered as-is, so a caller can set its own size or weight on the text. */
  label?: React.ReactNode;
  onChange?: (checked: boolean) => void;
  style?: React.CSSProperties;
}
export declare function Switch(props: SwitchProps): JSX.Element;
