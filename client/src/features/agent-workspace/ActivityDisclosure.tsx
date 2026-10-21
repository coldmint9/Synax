import { Transition } from "@headlessui/react";
import type { ReactNode } from "react";

/** Mount details on demand and keep them alive for the short closing transition. */
export function ActivityDisclosure({ open, id, children, className = "" }: {
  open: boolean;
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Transition show={open} as="div" id={id} className={`session-activity-reveal ${className}`} inert={!open} aria-hidden={!open}>
      <div className="session-activity-clip">{children}</div>
    </Transition>
  );
}
