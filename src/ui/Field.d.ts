/** Label, hint and error scaffolding for form controls. */
export interface FieldProps {
  label?: string;
  hint?: string;
  /** When set, replaces the hint and turns the message red. */
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Field(props: FieldProps): JSX.Element;
