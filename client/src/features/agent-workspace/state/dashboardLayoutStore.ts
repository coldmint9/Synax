import { create } from "zustand";

export const DASHBOARD_LAYOUT_KEY = "synax-workspace-dashboard-layout-v1";
export interface DashboardPanelSize {
  width: number;
  height: number;
}
export interface DashboardLayout {
  order: string[];
  sizes: Record<string, DashboardPanelSize>;
  hidden?: string[];
}
const EMPTY: DashboardLayout = { order: [], sizes: {} };

export function normalizePanelSize(
  size: DashboardPanelSize,
): DashboardPanelSize {
  return {
    width: 1,
    height: Math.max(
      100,
      Math.min(900, Number.isFinite(size.height) ? size.height : 280),
    ),
  };
}
function readLayouts(): Record<string, DashboardLayout> {
  try {
    const data = JSON.parse(localStorage.getItem(DASHBOARD_LAYOUT_KEY) || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(
      Object.entries(data).flatMap(([scope, value]) => {
        const entry = value as DashboardLayout;
        if (
          !entry ||
          !Array.isArray(entry.order) ||
          !entry.sizes ||
          typeof entry.sizes !== "object"
        )
          return [];
        const order = [
          ...new Set(entry.order.filter((id) => typeof id === "string")),
        ];
        const sizes = Object.fromEntries(
          Object.entries(entry.sizes).flatMap(([id, size]) =>
            size &&
            typeof size.width === "number" &&
            typeof size.height === "number"
              ? [[id, normalizePanelSize(size)]]
              : [],
          ),
        );
        const hidden = Array.isArray(entry.hidden)
          ? [...new Set(entry.hidden.filter((id) => typeof id === "string"))]
          : [];
        return [[scope, { order, sizes, hidden }]];
      }),
    );
  } catch {
    return {};
  }
}
export function panelOrder(saved: string[], visible: string[]): string[] {
  return [
    ...new Set([...saved.filter((id) => visible.includes(id)), ...visible]),
  ];
}
interface State {
  layouts: Record<string, DashboardLayout>;
  catalogs: Record<string, { id: string; label: string }[]>;
  register: (scope: string, widgets: { id: string; label: string }[]) => void;
  setVisible: (scope: string, id: string, visible: boolean) => void;
  move: (
    scope: string,
    id: string,
    target: string,
    after: boolean,
    visible: string[],
  ) => void;
  resize: (scope: string, id: string, size: DashboardPanelSize | null) => void;
}
export const useDashboardLayoutStore = create<State>((set, get) => {
  const save = (scope: string, layout: DashboardLayout | null) => {
    const layouts = { ...get().layouts };
    if (layout) layouts[scope] = layout;
    else delete layouts[scope];
    set({ layouts });
    try {
      localStorage.setItem(DASHBOARD_LAYOUT_KEY, JSON.stringify(layouts));
    } catch {
      /* Session-only preferences if storage is unavailable. */
    }
  };
  return {
    layouts: readLayouts(),
    catalogs: {},
    register: (scope, widgets) => {
      if (JSON.stringify(get().catalogs[scope]) === JSON.stringify(widgets)) return;
      set({ catalogs: { ...get().catalogs, [scope]: widgets } });
    },
    setVisible: (scope, id, visible) => {
      const layout = get().layouts[scope] ?? EMPTY;
      const hidden = new Set(layout.hidden ?? []);
      if (visible) hidden.delete(id);
      else hidden.add(id);
      save(scope, { ...layout, hidden: [...hidden] });
    },
    move: (scope, id, target, after, visible) => {
      if (id === target || !visible.includes(id) || !visible.includes(target))
        return;
      const layout = get().layouts[scope] ?? EMPTY;
      const order = [...new Set([...layout.order, ...visible])].filter(
        (key) => key !== id,
      );
      order.splice(order.indexOf(target) + (after ? 1 : 0), 0, id);
      save(scope, { ...layout, order });
    },
    resize: (scope, id, size) => {
      const layout = get().layouts[scope] ?? EMPTY;
      const sizes = { ...layout.sizes };
      if (size) sizes[id] = normalizePanelSize(size);
      else delete sizes[id];
      save(scope, { ...layout, sizes });
    },
  };
});
