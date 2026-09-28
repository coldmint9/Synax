import { Portal } from "@headlessui/react";
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useMergeRefs,
  useRole,
  type Placement,
} from "@floating-ui/react";
import {
  cloneElement,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type RefAttributes,
} from "react";
import "./Tooltip.css";

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement<
    HTMLAttributes<HTMLElement> & RefAttributes<HTMLElement>
  >;
  delay?: number;
  placement?: Placement;
  openOnFocus?: boolean;
}

/** One real trigger, no layout wrapper, and a portal that only exists while visible. */
export function Tooltip({
  children,
  content,
  delay = 350,
  placement = "top",
  openOnFocus = true,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, {
    move: false,
    mouseOnly: true,
    delay: { open: delay, close: 80 },
  });
  const focus = useFocus(context, { enabled: openOnFocus });
  const dismiss = useDismiss(context, { escapeKey: true, referencePress: true });
  const role = useRole(context, { role: "tooltip" });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    dismiss,
    role,
  ]);
  const ref = useMergeRefs([refs.setReference, children.props.ref]);

  return (
    <>
      {cloneElement(children, { ...getReferenceProps(children.props), ref })}
      {open && content ? (
        <Portal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="ui-tooltip"
          >
            {content}
          </div>
        </Portal>
      ) : null}
    </>
  );
}
