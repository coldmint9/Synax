import {
  Tab as HeadlessTab,
  TabGroup,
  TabList as HeadlessList,
  TabPanel as HeadlessPanel,
  TabPanels,
  type TabProps,
} from "@headlessui/react";
import clsx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";

export { TabGroup, TabPanels };
export function TabList({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <HeadlessList
      {...props}
      className={clsx("flex min-w-0 items-center gap-1", className)}
    />
  );
}
export const Tab = forwardRef<
  HTMLButtonElement,
  Omit<TabProps<"button">, "as" | "className"> & { className?: string }
>(function Tab({ className, ...props }, ref) {
  return (
    <HeadlessTab
      {...props}
      ref={ref}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted-foreground outline-none transition-colors data-selected:bg-card data-selected:text-foreground data-selected:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
        className,
      )}
    />
  );
});
export function TabPanel({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <HeadlessPanel
      {...props}
      className={clsx(
        "min-w-0 outline-none focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    />
  );
}
