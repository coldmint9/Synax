import {
  createContext,
  forwardRef,
  isValidElement,
  cloneElement,
  useContext,
  Children,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import {
  Dialog as HDialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Popover as HPopover,
  PopoverButton,
  PopoverPanel,
  Transition,
} from "@headlessui/react";
import { Check, ChevronDown, X } from "lucide-react";

const cx = (...values: Array<string | undefined | false | null>) =>
  values.filter(Boolean).join(" ");

type AnyProps = Record<string, any> & {
  onChange?: (value: any) => void;
  onValueChange?: (value: any) => void;
  onOpenChange?: (value: boolean) => void;
  onAction?: (value: any) => void;
  onSelectionChange?: (value: any) => void;
  onPress?: (event: any) => void;
};
function pressProps(props: AnyProps) {
  const { onPress, isDisabled, isLoading, isPending, onClick, ...rest } = props;
  return {
    ...rest,
    disabled: Boolean(isDisabled || isLoading || rest.disabled),
    onClick: (event: any) => {
      onClick?.(event);
      if (!event.defaultPrevented && !isDisabled && !isLoading) onPress?.(event);
    },
    "aria-disabled": isDisabled ? true : rest["aria-disabled"],
  };
}

export const RouterProvider: any = ({ children }: { navigate?: unknown; children: ReactNode }) => <>{children}</>;

export const Button: any = forwardRef<HTMLButtonElement, AnyProps>(function Button(
  { children, className, variant = "default", size = "md", isIconOnly, ...props },
  ref,
) {
  const Tag = props.href ? "a" : "button";
  const normalized = pressProps(props);
  return (
    <Tag
      ref={ref as any}
      type={Tag === "button" ? (props.type ?? "button") : undefined}
      className={cx(
        "synax-control synax-button",
        `synax-button--${variant}`,
        `synax-button--${size}`,
        isIconOnly && "synax-button--icon",
        className,
      )}
      {...normalized}
    >
      {typeof children === "function" ? children({ isPending: Boolean(props.isPending || props.isLoading) }) : children}
    </Tag>
  );
});

const FieldContext = createContext<{ id?: string; value?: any; onChange?: (value: any) => void; disabled?: boolean }>({});
export const Input: any = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & AnyProps>(function Input(
  { className, isDisabled, ...props }, ref,
) {
  const field = useContext(FieldContext);
  const hasFieldValue = field.value !== undefined && props.value === undefined && props.defaultValue === undefined;
  return <input ref={ref} id={props.id ?? field.id} className={cx("synax-input", className)} disabled={isDisabled ?? props.disabled ?? field.disabled} value={hasFieldValue ? field.value : props.value} onChange={props.onChange ?? (field.onChange ? (event) => field.onChange?.(event.currentTarget.value) : undefined)} aria-label={props["aria-label"]} {...props} />;
});
export const TextArea: any = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & AnyProps>(function TextArea(
  { className, isDisabled, ...props }, ref,
) { const field = useContext(FieldContext); return <textarea ref={ref} id={props.id ?? field.id} className={cx("synax-input synax-textarea", className)} disabled={isDisabled ?? props.disabled ?? field.disabled} value={field.value !== undefined && props.value === undefined ? field.value : props.value} onChange={props.onChange ?? (field.onChange ? (event) => field.onChange?.(event.currentTarget.value) : undefined)} {...props} />; });
export const Label: any = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement> & AnyProps>(function Label(
  { className, htmlFor, ...props }, ref,
) { const field = useContext(FieldContext); return <label ref={ref} htmlFor={htmlFor ?? field.id} className={cx("synax-label", className)} {...props} />; });
export const Description: any = ({ children, className, ...props }: AnyProps) => <p className={cx("synax-description", className)} {...props}>{children}</p>;
export const FieldError: any = ({ children, className, ...props }: AnyProps) => <p role="alert" className={cx("synax-field-error", className)} {...props}>{children}</p>;
export const Header: any = ({ children, className, ...props }: AnyProps) => <div className={cx("synax-header", className)} {...props}>{children}</div>;
export const Separator: any = ({ className, orientation = "horizontal", ...props }: AnyProps) => <div role="separator" className={cx("synax-separator", `synax-separator--${orientation}`, className)} {...props} />;
export const ScrollShadow: any = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & AnyProps>(function ScrollShadow({ className, ...props }, ref) { return <div ref={ref} className={cx("synax-scroll-shadow", className)} {...props} />; });
export const Surface: any = ({ children, className, variant = "default", ...props }: AnyProps) => <div className={cx("synax-surface", `synax-surface--${variant}`, className)} {...props}>{children}</div>;
export const Card: any = Object.assign(
  ({ children, className, ...props }: AnyProps) => <section className={cx("synax-card", className)} {...props}>{children}</section>,
  {
    Header: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-card__header", className)} {...props}>{children}</div>,
    Content: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-card__content", className)} {...props}>{children}</div>,
    Footer: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-card__footer", className)} {...props}>{children}</div>,
    Title: ({ children, className, ...props }: AnyProps) => <h3 className={cx("synax-card__title", className)} {...props}>{children}</h3>,
  },
);
export const Chip: any = ({ children, className, size = "md", variant = "soft", color = "default", ...props }: AnyProps) => <span className={cx("synax-chip", `synax-chip--${size}`, `synax-chip--${variant}`, `synax-chip--${color}`, className)} {...props}>{children}</span>;
export const Spinner: any = ({ size = "md", className, ...props }: AnyProps) => <span aria-label={props["aria-label"] ?? "Loading"} className={cx("synax-spinner", `synax-spinner--${size}`, className)} {...props} />;
export const Skeleton: any = ({ className, ...props }: AnyProps) => <span className={cx("synax-skeleton", className)} {...props} />;
export const ProgressBar: any = Object.assign(({ value = 0, maxValue = 100, className, children, ...props }: AnyProps) => <div className={cx("synax-progress", className)} {...props}><span style={{ width: `${Math.max(0, Math.min(100, (value / maxValue) * 100))}%` }} />{children}</div>, { Track: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-progress__track", className)} {...props}>{children}</div>, Fill: ({ className, ...props }: AnyProps) => <span className={cx("synax-progress__fill", className)} {...props} /> });
export const Typography: any = ({ children, type = "body", color, className, ...props }: AnyProps) => { const Tag = type.startsWith("h") ? type : type === "body" ? "p" : "span"; return <Tag className={cx("synax-typography", `synax-typography--${type}`, color && `text-${color}`, className)} {...props}>{children}</Tag>; };

export function useOverlayState({ onOpenChange }: { onOpenChange?: (open: boolean) => void } = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const setOpen = (open: boolean) => { setIsOpen(open); onOpenChange?.(open); };
  return { isOpen, open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!isOpen), setOpen };
}

type ModalContextValue = { close: () => void; open: boolean };
const ModalContext = createContext<ModalContextValue>({ open: false, close: () => {} });
function modalSize(size?: string) { return size === "lg" ? "max-w-3xl" : size === "sm" ? "max-w-md" : "max-w-xl"; }
function nestedProp(node: any, key: string): any { if (!isValidElement(node)) return undefined; const props = node.props as AnyProps; if (props[key] !== undefined) return props[key]; return Children.toArray(props.children).map((item) => nestedProp(item, key)).find((value) => value !== undefined); }
function nestedClassName(node: any): string {
  if (!isValidElement(node)) return "";
  const props = node.props as AnyProps;
  if (typeof props.className === "string") return props.className;
  const nested = Children.toArray(props.children);
  return nested.map(nestedClassName).find(Boolean) ?? "";
}
const ModalBackdrop = ({ children, isOpen, onOpenChange, className, ...props }: AnyProps) => {
  const parent = useContext(ModalContext);
  const open = isOpen ?? parent.open;
  const close = () => { onOpenChange?.(false); parent.close(); };
  return <HDialog key={String(open)} open={open} onClose={close} className={cx("synax-dialog-root", nestedClassName(children))} data-slot={nestedProp(children, "data-slot") ?? (nestedProp(children, "placement") ? "drawer-content" : undefined)} data-placement={nestedProp(children, "placement")} {...props}>
    <DialogBackdrop className={cx("synax-overlay dialog-overlay modal__backdrop drawer__backdrop", className)} />
    <ModalContext.Provider value={{ open, close }}><div className="synax-overlay__viewport"><div className="synax-overlay__container modal__container">{children}</div></div></ModalContext.Provider>
  </HDialog>;
};
const ModalContainer = ({ children, size, className, ...props }: AnyProps) => <div className={cx("synax-modal-container", modalSize(size), className)} {...props}>{children}</div>;
const ModalDialog = ({ children, className, role = "dialog", ...props }: AnyProps) => <DialogPanel role={role} className={cx("synax-modal modal__dialog drawer__dialog", className)} {...props}>{children}</DialogPanel>;
const ModalClose = ({ className, onPress, onClick, ...props }: AnyProps) => { const { close } = useContext(ModalContext); return <button type="button" aria-label="Close" className={cx("synax-modal-close", className)} onClick={(event) => { onClick?.(event); onPress?.(event); if (!event.defaultPrevented) close(); }} {...props}><X size={15} /></button>; };
const Modal: any = Object.assign(({ children, isOpen = false, onOpenChange, ...props }: AnyProps) => <ModalContext.Provider value={{ open: isOpen, close: () => onOpenChange?.(false) }}><div {...props}>{children}</div></ModalContext.Provider>, {
  Backdrop: ModalBackdrop,
  Container: ModalContainer,
  Dialog: ModalDialog,
  CloseTrigger: ModalClose,
  Header: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-modal__header", className)} {...props}>{children}</div>,
  Heading: ({ children, className, ...props }: AnyProps) => <DialogTitle className={cx("synax-modal__heading", className)} {...props}>{children}</DialogTitle>,
  Body: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-modal__body", className)} {...props}>{children}</div>,
  Footer: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-modal__footer", className)} {...props}>{children}</div>,
  Icon: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-modal__icon", className)} {...props}>{children}</div>, Content: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-modal__content", className)} {...props}>{children}</div>,
});
export { Modal };
export const AlertDialog: any = Object.assign(Modal, { Backdrop: ModalBackdrop, Dialog: (props: AnyProps) => <ModalDialog role="alertdialog" {...props} /> });
export const Drawer: any = Object.assign(Modal, { Backdrop: ModalBackdrop, Content: ({ children, className, placement, ...props }: AnyProps) => <div data-slot="drawer-content" data-placement={placement} className={cx("synax-drawer-content", className)} {...props}>{children}</div> });

const PopoverContext = createContext<{ close: () => void; open: boolean; internalOpen: boolean; controlled: boolean }>({ close: () => {}, open: false, internalOpen: false, controlled: false });
function PopoverBridge({ children, open, internalOpen, close, isControlled, onOpenChange }: AnyProps) {
  const previousExternal = useRef<boolean | undefined>(undefined);
  const previousInternal = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (isControlled && previousExternal.current === true && open === false && internalOpen) close();
    previousExternal.current = isControlled ? open : undefined;
  }, [isControlled, open, internalOpen, close]);
  useEffect(() => { if (previousInternal.current !== internalOpen) onOpenChange?.(internalOpen); previousInternal.current = internalOpen; }, [internalOpen, onOpenChange]);
  useEffect(() => { if (!open) return; const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); onOpenChange?.(false); } }; document.addEventListener("keydown", onEscape, true); return () => document.removeEventListener("keydown", onEscape, true); }, [open, close, onOpenChange]);
  return <PopoverContext.Provider value={{ close, open, internalOpen, controlled: isControlled }}>{children}</PopoverContext.Provider>;
}
const PopoverContent = ({ children, className, placement, offset, ...props }: AnyProps) => { const state = useContext(PopoverContext); return state.open || !state.controlled ? <PopoverPanel static={state.controlled} transition={false} className={cx("synax-popover", className)} onKeyDown={(event: any) => { if (event.key === "Escape") state.close(); props.onKeyDown?.(event); }} {...props}>{children}</PopoverPanel> : null; };
const PopoverRoot = ({ children, isOpen, onOpenChange, ...props }: AnyProps) => <HPopover className="relative" {...props}>{({ open, close }: any) => <PopoverBridge open={isOpen ?? open} internalOpen={open} close={close} isControlled={isOpen !== undefined} onOpenChange={onOpenChange}>{children}</PopoverBridge>}</HPopover>;
const Popover: any = Object.assign(PopoverRoot, {
  Trigger: forwardRef<HTMLButtonElement, AnyProps>(function Trigger({ children, className, render, ...props }, ref) { return <PopoverButton ref={ref} className={cx("synax-popover-trigger", className)} {...pressProps(props)}>{children}</PopoverButton>; }),
  Content: PopoverContent,
  Dialog: ({ children, className, ...props }: AnyProps) => <div role="dialog" className={cx("synax-popover__dialog", className)} {...props}>{children}</div>,
  Arrow: ({ className, ...props }: AnyProps) => <span aria-hidden="true" className={cx("synax-popover__arrow", className)} {...props} />,
  Heading: ({ children, className, ...props }: AnyProps) => <h3 className={cx("synax-popover__heading", className)} {...props}>{children}</h3>,
});
export { Popover };

interface DropdownValue { open: boolean; setOpen: (value: boolean) => void; action?: (key: string) => void; }
const DropdownContext = createContext<DropdownValue>({ open: false, setOpen: () => {} });
function DropdownRoot({ children, isOpen, onOpenChange, ...props }: AnyProps) {
  const [internal, setInternal] = useState(false);
  const open = isOpen ?? internal;
  const setOpen = (value: boolean) => { if (isOpen === undefined) setInternal(value); onOpenChange?.(value); };
  useEffect(() => { if (!open) return; const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".synax-dropdown")) setOpen(false); }; const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); }; document.addEventListener("mousedown", close); document.addEventListener("keydown", escape); return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); }; }, [open]);
  const items = Children.toArray(children);
  const first = items[0];
  const wrapped = isValidElement(first) && (first.type as any) !== DropdownTrigger
    ? cloneElement(first as any, { "aria-expanded": open, onClick: (event: any) => { (first.props as AnyProps)?.onClick?.(event); if (!event.defaultPrevented) setOpen(!open); } })
    : first;
  return <DropdownContext.Provider value={{ open, setOpen }}><div className="synax-dropdown" {...props}>{wrapped}{items.slice(1)}</div></DropdownContext.Provider>;
}
const DropdownTrigger = forwardRef<HTMLButtonElement, AnyProps>(function DropdownTrigger({ children, className, ...props }, ref) { const { open, setOpen } = useContext(DropdownContext); return <button ref={ref} type="button" aria-expanded={open} className={cx("synax-dropdown-trigger", className)} onClick={(e) => { props.onClick?.(e); if (!e.defaultPrevented) setOpen(!open); }} {...props}>{children}</button>; });
const DropdownPopover = ({ children, className, ...props }: AnyProps) => { const { open } = useContext(DropdownContext); return open ? <div className={cx("synax-dropdown-popover", className)} {...props}>{children}</div> : null; };
const DropdownMenu = ({ children, onAction, className, ...props }: AnyProps) => <DropdownContext.Provider value={{ ...useContext(DropdownContext), action: onAction }}><div role="menu" className={cx("synax-dropdown-menu", className)} {...props}>{children}</div></DropdownContext.Provider>;
const DropdownItem = ({ children, id, isDisabled, className, variant, ...props }: AnyProps) => { const { setOpen, action } = useContext(DropdownContext); return <button type="button" role="menuitem" data-menu-key={id} data-key={id} disabled={isDisabled} className={cx("synax-dropdown-item", variant === "danger" && "synax-dropdown-item--danger", className)} onClick={(event) => { props.onClick?.(event); if (!event.defaultPrevented && !isDisabled) { action?.(id); setOpen(false); } }} {...props}>{children}</button>; };
export const Dropdown: any = Object.assign(DropdownRoot, {
  Trigger: DropdownTrigger, Popover: DropdownPopover, Menu: DropdownMenu, Item: DropdownItem,
  Section: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-dropdown-section", className)} {...props}>{children}</div>,
  SubmenuTrigger: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-dropdown-submenu", className)} {...props}>{children}</div>,
  SubmenuIndicator: ({ className, ...props }: AnyProps) => <ChevronDown size={13} className={cx("synax-dropdown-submenu-indicator", className)} {...props} />,
});

interface SelectContextValue { value: string | null; setValue: (value: string) => void; open: boolean; setOpen: (value: boolean) => void; label?: string; labels?: Record<string, ReactNode>; registerLabel?: (key: string, label: ReactNode) => void; disabled?: boolean; displayValue?: ReactNode; }
const SelectContext = createContext<SelectContextValue>({ value: null, setValue: () => {}, open: false, setOpen: () => {}, labels: {} });
function SelectRoot({ children, value, defaultValue, onChange, isDisabled, className, "aria-label": ariaLabel, displayValue, ...props }: AnyProps) { const [internal, setInternal] = useState<string | null>(defaultValue ?? null); const [open, setOpen] = useState(false); const [labels, setLabels] = useState<Record<string, ReactNode>>({}); const current = value ?? internal; const setValue = (v: string) => { setInternal(v); onChange?.(v); setOpen(false); }; const registerLabel = (key: string, label: ReactNode) => setLabels((previous) => previous[key] !== undefined ? previous : { ...previous, [key]: label }); return <SelectContext.Provider value={{ value: current, setValue, open, setOpen, label: ariaLabel, labels, registerLabel, disabled: isDisabled, displayValue }}><div className={cx("synax-select", isDisabled && "is-disabled", className)} {...props}>{children}</div></SelectContext.Provider>; }
const SelectTrigger = ({ children, className, ...props }: AnyProps) => { const s = useContext(SelectContext); return <button type="button" data-slot="select-trigger" disabled={(props as any).isDisabled ?? s.disabled} aria-expanded={s.open} aria-label={props["aria-label"] ?? s.label} className={cx("synax-select-trigger", className)} onClick={() => s.setOpen(!s.open)} {...props}>{children}</button>; };
const SelectValue = ({ placeholder, ...props }: AnyProps) => { const s = useContext(SelectContext); return <span {...props}>{props.children ?? s.displayValue ?? (s.value ? s.labels?.[s.value] : undefined) ?? placeholder ?? "Select"}</span>; };
const SelectIndicator = () => <ChevronDown data-slot="select-default-indicator" size={14} aria-hidden="true" />;
const SelectPopover = ({ children, className, ...props }: AnyProps) => { const s = useContext(SelectContext); return <div hidden={!s.open} className={cx("synax-select-popover", className)} {...props}>{children}</div>; };
const StandaloneListBoxContext = createContext<{ selected: Set<string>; select: (key: string) => void } | null>(null);
const ListBox: any = Object.assign(({ children, className, selectedKeys, onSelectionChange, ...props }: AnyProps) => {
  const [internal, setInternal] = useState<Set<string>>(new Set());
  const s = useContext(SelectContext);
  const { ["aria-label"]: listLabel, ...restProps } = props;
  const selected = selectedKeys instanceof Set ? selectedKeys : internal;
  const select = (key: string) => { const next = new Set([key]); setInternal(next); onSelectionChange?.(next); };
  const content = <div role="listbox" aria-label={s.label ? undefined : listLabel} className={cx("synax-listbox", className)} {...restProps}>{children}</div>;
  return selectedKeys !== undefined || onSelectionChange ? <StandaloneListBoxContext.Provider value={{ selected, select }}>{content}</StandaloneListBoxContext.Provider> : content;
}, {
  Item: ({ children, id, isDisabled, textValue, className, ...props }: AnyProps) => { const s = useContext(SelectContext); const standalone = useContext(StandaloneListBoxContext); const popover = useContext(PopoverContext); const selected = standalone ? standalone.selected.has(String(id)) : s.value === id; useEffect(() => { if (!standalone && id != null) s.registerLabel?.(String(id), typeof children === "string" ? (textValue ?? children) : (children ?? String(id))); }, [id, textValue, children, standalone]); return <button type="button" role="option" aria-selected={selected} aria-disabled={isDisabled ? "true" : undefined} data-key={id} disabled={isDisabled} className={cx("synax-listbox-item", selected && "is-selected", className)} onKeyDown={(event) => { const options = Array.from((event.currentTarget.parentElement?.querySelectorAll('[role="option"]') ?? []) as NodeListOf<HTMLElement>).filter((item) => item.getAttribute("aria-disabled") !== "true"); const index = options.indexOf(event.currentTarget); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); options[(index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length]?.focus(); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.click(); } }} onClick={() => { if (isDisabled) return; standalone?.select(String(id)); s.setValue(String(id)); popover.close(); }} {...props}>{children}</button>; },
  ItemIndicator: ({ className }: AnyProps) => <Check size={14} className={cx("synax-listbox-indicator", className)} />,
});
const Select: any = Object.assign(SelectRoot, { Trigger: SelectTrigger, Value: SelectValue, Indicator: SelectIndicator, Popover: SelectPopover });
export { Select, ListBox };

export const Switch: any = Object.assign(forwardRef<HTMLButtonElement, AnyProps>(function Switch({ isSelected, defaultSelected, onChange, onValueChange, className, children, ...props }, ref) { const [selected, setSelected] = useState(Boolean(defaultSelected)); const checked = isSelected ?? selected; return <button ref={ref} type="button" role="switch" aria-checked={checked} className={cx("synax-switch", checked && "is-selected", className)} onClick={() => { const next = !checked; setSelected(next); onChange?.(next); onValueChange?.(next); }} {...props}><span className="synax-switch__thumb" />{children}</button>; }), { Content: ({ children, className, ...props }: AnyProps) => <span className={cx("synax-switch__content", className)} {...props}>{children}</span>, Control: ({ children, className, ...props }: AnyProps) => <span className={cx("synax-switch__control", className)} {...props}>{children}</span>, Thumb: ({ className, ...props }: AnyProps) => <span className={cx("synax-switch__thumb", className)} {...props} /> });
export const Checkbox: any = Object.assign(forwardRef<HTMLInputElement, AnyProps>(function Checkbox({ isSelected, defaultSelected, onChange, children, className, ...props }, ref) { return <label className={cx("synax-checkbox", className)}><input ref={ref} type="checkbox" checked={isSelected} defaultChecked={defaultSelected} onChange={(e) => onChange?.(e.target.checked)} {...props} /><span>{children}</span></label>; }), { Content: ({ children, className, ...props }: AnyProps) => <span className={cx("synax-checkbox__content", className)} {...props}>{children}</span>, Control: ({ children, className, ...props }: AnyProps) => <span className={cx("synax-checkbox__control", className)} {...props}>{children}</span>, Indicator: ({ className, ...props }: AnyProps) => <span className={cx("synax-checkbox__indicator", className)} {...props}><Check size={12} /></span> });

const TabsContext = createContext<{ selected: string; select: (key: string) => void }>({ selected: "", select: () => {} });
function TabsRoot({ children, selectedKey, defaultSelectedKey, onSelectionChange, className, ...props }: AnyProps) { const [internal, setInternal] = useState(defaultSelectedKey ?? selectedKey ?? ""); const selected = selectedKey ?? internal; const select = (key: string) => { setInternal(key); onSelectionChange?.(key); }; return <TabsContext.Provider value={{ selected, select }}><div className={cx("synax-tabs", className)} {...props}>{children}</div></TabsContext.Provider>; }
const TabsList = ({ children, className, ...props }: AnyProps) => <div role="tablist" className={cx("synax-tabs-list", className)} {...props}>{children}</div>;
const TabsTab = ({ children, id, isDisabled, className, ...props }: AnyProps) => { const t = useContext(TabsContext); return <button type="button" role="tab" aria-selected={t.selected === id} disabled={isDisabled} className={cx("synax-tab", t.selected === id && "is-selected", className)} onClick={() => !isDisabled && t.select(id)} {...props}>{children}</button>; };
const TabsPanel = ({ children, id, className, ...props }: AnyProps) => { const t = useContext(TabsContext); return t.selected === id ? <div role="tabpanel" className={className} {...props}>{children}</div> : null; };
export const Tabs: any = Object.assign(TabsRoot, { List: TabsList, ListContainer: ({ children, className, ...props }: AnyProps) => <div className={className} {...props}>{children}</div>, Tab: Object.assign(TabsTab, { Indicator: ({ className }: AnyProps) => <span className={cx("synax-tab-indicator", className)} />, Separator: ({ className }: AnyProps) => <span className={cx("synax-tab-separator", className)} /> }), Panel: TabsPanel, Indicator: ({ className }: AnyProps) => <span className={cx("synax-tab-indicator", className)} />, Separator: ({ className }: AnyProps) => <span className={cx("synax-tab-separator", className)} /> });

export const Tooltip: any = Object.assign(({ children, delay, ...props }: AnyProps) => <span className="synax-tooltip" {...props}>{children}</span>, { Content: ({ children, className, ...props }: AnyProps) => <span role="tooltip" className={cx("synax-tooltip__content", className)} {...props}>{children}</span> });
export const RadioGroup: any = ({ children, value, onChange, className, ...props }: AnyProps) => <div role="radiogroup" className={className} {...props}>{children}</div>;
export const Radio: any = ({ children, value, className, ...props }: AnyProps) => <label className={cx("synax-radio", className)} {...props}><input type="radio" value={value} name={props.name} /><span>{children}</span></label>;

export const Accordion: any = Object.assign(({ children, className, ...props }: AnyProps) => <div className={className} {...props}>{children}</div>, { Item: ({ children, id, ...props }: AnyProps) => <details {...props}>{children}</details>, Heading: ({ children, className, ...props }: AnyProps) => <div className={className} {...props}>{children}</div>, Trigger: ({ children, className, ...props }: AnyProps) => <summary className={className} {...props}>{children}</summary>, Indicator: ({ className }: AnyProps) => <ChevronDown className={className} />, Panel: ({ children, className, ...props }: AnyProps) => <div className={className} {...props}>{children}</div>, Body: ({ children, className, ...props }: AnyProps) => <div className={className} {...props}>{children}</div> });
const PaginationRoot = ({ children, className, ...props }: AnyProps) => <div className={cx("synax-pagination", className)} {...props}>{children}</div>;
export const Pagination: any = Object.assign(PaginationRoot, { Content: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-pagination__content", className)} {...props}>{children}</div>, Item: ({ children, className, ...props }: AnyProps) => <div className={cx("synax-pagination__item", className)} {...props}>{children}</div>, Previous: ({ children, className, ...props }: AnyProps) => <Button variant="ghost" className={className} {...props}>{children}</Button>, Next: ({ children, className, ...props }: AnyProps) => <Button variant="ghost" className={className} {...props}>{children}</Button>, PreviousIcon: () => <span aria-hidden="true">‹</span>, NextIcon: () => <span aria-hidden="true">›</span> });

export type ColorValue = { hex: string; toFormat: (format: string) => ColorValue; toString: (format?: string) => string };
export function parseColor(value: string): ColorValue { const hex = value.startsWith("#") ? value : `#${value}`; return { hex, toFormat: () => parseColor(hex), toString: (format = "hex") => format === "hex" ? hex : hex }; }
const colorOf = (value: any) => typeof value === "string" ? value : value?.hex ?? "#888888";
export const ColorSwatch: any = ({ color, size, className }: AnyProps) => <span className={cx("synax-color-swatch", className)} style={{ backgroundColor: colorOf(color) }} />;
export const ColorSwatchPicker: any = Object.assign(({ children, value, onChange, className, ...props }: AnyProps) => <div role="radiogroup" className={cx("synax-color-swatches", className)} {...props}>{children}</div>, { Item: ({ children, color, onClick, ...props }: AnyProps) => <button type="button" className="synax-color-swatch-item" style={{ backgroundColor: color }} onClick={() => onClick?.(color)} {...props}>{children}</button>, Swatch: ({ color, ...props }: AnyProps) => <ColorSwatch color={color} {...props} />, Indicator: ({ children = <Check size={13} />, ...props }: AnyProps) => <span className="synax-color-indicator" {...props}>{children}</span> });
export const ColorPicker: any = ({ children, value, onChange }: AnyProps) => <div className="synax-color-picker">{children}</div>;
export const ColorArea: any = Object.assign(({ children, className, ...props }: AnyProps) => <div className={cx("synax-color-area", className)} {...props}><input type="color" aria-label={props["aria-label"]} value={colorOf(props.color)} onChange={(e) => props.onChange?.(parseColor(e.target.value))} />{children}</div>, { Thumb: ({ className }: AnyProps) => <span className={cx("synax-color-thumb", className)} /> });
export const ColorSlider: any = Object.assign(({ children, className, ...props }: AnyProps) => <div className={cx("synax-color-slider", className)} {...props}><input type="range" min="0" max="360" aria-label={props["aria-label"]} />{children}</div>, { Track: ({ children, className }: AnyProps) => <div className={cx("synax-color-slider__track", className)}>{children}</div>, Thumb: ({ className }: AnyProps) => <span className={cx("synax-color-slider__thumb", className)} /> });
ColorPicker.Trigger = ({ children, className, ...props }: AnyProps) => <button type="button" className={className} {...props}>{children}</button>;
ColorPicker.Popover = ({ children, className, ...props }: AnyProps) => <div className={className} {...props}>{children}</div>;
export const ColorField: any = ({ children, className, ...props }: AnyProps) => <div className={cx("synax-color-field", className)} {...props}>{children}</div>;
export const TextField: any = ({ children, className, value, onChange, ...props }: AnyProps) => { const id = useId(); return <FieldContext.Provider value={{ id, value, onChange, disabled: props.isDisabled ?? props.isPending }}><div className={cx("synax-field", className)} {...props}>{children}</div></FieldContext.Provider>; };
export const InputGroup: any = Object.assign(({ children, className, ...props }: AnyProps) => <div className={cx("synax-input-group", className)} {...props}>{children}</div>, { Input: Input, Prefix: ({ children, className, ...props }: AnyProps) => <span className={cx("synax-input-group__prefix", className)} {...props}>{children}</span>, Suffix: ({ children, className, ...props }: AnyProps) => <span className={cx("synax-input-group__suffix", className)} {...props}>{children}</span> });

export default {};
