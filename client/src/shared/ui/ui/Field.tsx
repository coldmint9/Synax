import {
  Description as HeadlessDescription,
  Field as HeadlessField,
  Input as HeadlessInput,
  Label as HeadlessLabel,
  Textarea as HeadlessTextarea,
} from "@headlessui/react";
import clsx from "clsx";
import {
  createContext,
  forwardRef,
  useContext,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

const FieldState = createContext<boolean | null>(null);
export type FieldProps = HTMLAttributes<HTMLDivElement> & {
  disabled?: boolean;
  invalid?: boolean;
};
export const Field = forwardRef<HTMLDivElement, FieldProps>(function Field(
  { invalid = false, disabled, className, ...props },
  ref,
) {
  return (
    <FieldState.Provider value={invalid}>
      <HeadlessField
        {...props}
        ref={ref}
        disabled={disabled}
        className={clsx("ui-field grid gap-1.5", className)}
      />
    </FieldState.Provider>
  );
});

const inputClasses =
  "ui-input min-w-0 w-full rounded-lg border border-border/80 bg-card px-2.5 py-1.5 text-[13px] text-foreground shadow-inner outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 data-invalid:border-destructive data-invalid:focus:ring-destructive/20";
export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, ...props },
  ref,
) {
  const fieldInvalid = useContext(FieldState);
  // Outside a Field, native ARIA references belong to the caller, not a label provider.
  if (fieldInvalid === null)
    return (
      <input
        {...props}
        ref={ref}
        aria-invalid={invalid || props["aria-invalid"]}
        data-invalid={invalid || undefined}
        className={clsx(inputClasses, className)}
      />
    );
  return (
    <HeadlessInput
      {...props}
      ref={ref}
      invalid={invalid ?? fieldInvalid}
      className={clsx(inputClasses, className)}
    />
  );
});
export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  function TextArea({ invalid, className, ...props }, ref) {
    const fieldInvalid = useContext(FieldState);
    if (fieldInvalid === null)
      return (
        <textarea
          {...props}
          ref={ref}
          aria-invalid={invalid || props["aria-invalid"]}
          data-invalid={invalid || undefined}
          className={clsx(inputClasses, "min-h-20 resize-y", className)}
        />
      );
    return (
      <HeadlessTextarea
        {...props}
        ref={ref}
        invalid={invalid ?? fieldInvalid}
        className={clsx(inputClasses, "min-h-20 resize-y", className)}
      />
    );
  },
);

export const Label = forwardRef<
  HTMLLabelElement,
  LabelHTMLAttributes<HTMLLabelElement>
>(function Label({ className, ...props }, ref) {
  const field = useContext(FieldState);
  const classes = clsx(
    "ui-label text-xs font-medium text-foreground",
    className,
  );
  return field === null ? (
    <label {...props} ref={ref} className={classes} />
  ) : (
    <HeadlessLabel {...props} ref={ref} className={classes} />
  );
});
export function Description({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  const field = useContext(FieldState);
  const classes = clsx(
    "ui-description text-xs leading-relaxed text-muted-foreground",
    className,
  );
  return field === null ? (
    <p {...props} className={classes} />
  ) : (
    <HeadlessDescription as="p" {...props} className={classes} />
  );
}
export function FieldError({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  const field = useContext(FieldState);
  const classes = clsx(
    "ui-field-error text-xs leading-relaxed text-destructive",
    className,
  );
  return field === null ? (
    <p {...props} role="alert" className={classes} />
  ) : (
    <HeadlessDescription as="p" {...props} role="alert" className={classes} />
  );
}

export function InputGroup({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={clsx(
        "ui-input-group flex min-w-0 items-center gap-1 rounded-lg border border-border/80 bg-card px-2.5 shadow-inner focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20 [&>.ui-input]:rounded-none [&>.ui-input]:border-0 [&>.ui-input]:bg-transparent [&>.ui-input]:px-0 [&>.ui-input]:shadow-none [&>.ui-input]:ring-0",
        className,
      )}
    />
  );
}
export function InputPrefix({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      className={clsx("shrink-0 text-xs text-muted-foreground", className)}
    />
  );
}
export function InputSuffix({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      className={clsx("shrink-0 text-xs text-muted-foreground", className)}
    />
  );
}
