import { Checkbox, Field, Label } from "@headlessui/react";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import { Button } from "@/shared/ui/ui/Button";
import {
  Dialog, DialogContainer, DialogPanel, DialogCloseButton,
  DialogHeader, DialogTitle, DialogBody, DialogFooter,
} from "@/shared/ui/ui/Dialog";
import { panelOrder, useDashboardLayoutStore } from "./state/dashboardLayoutStore";

export function WorkspaceWidgetManager({ open, onClose, scope }: {
  open: boolean;
  onClose: () => void;
  scope: string;
}) {
  const zh = useLocale().locale === "zh";
  const catalog = useDashboardLayoutStore((s) => s.catalogs[scope]);
  const layout = useDashboardLayoutStore((s) => s.layouts[scope]);
  const ids = catalog?.map((widget) => widget.id) ?? [];
  const order = panelOrder(layout?.order ?? [], ids);
  const visible = order.filter((id) => !layout?.hidden?.includes(id));

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogContainer size="sm">
        <DialogPanel>
          <DialogCloseButton />
          <DialogHeader>
            <DialogTitle>{zh ? "重新布局" : "Rearrange widgets"}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="mb-4 text-xs text-muted-foreground">
              {zh ? "勾选添加组件，取消勾选移除。调整顺序后自动保存到当前项目；右侧卡片支持拖动和调整尺寸。" : "Select widgets to add them; deselect to remove. Changes are saved for this project. Drag and resize cards in the work area."}
            </p>
            {order.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {zh ? "打开此项目的会话后即可管理工作组件。" : "Open a session in this project to manage widgets."}
              </p>
            ) : (
              <div className="space-y-2" aria-label={zh ? "组件库" : "Widget library"}>
                {order.map((id) => {
                  const widget = catalog!.find((item) => item.id === id)!;
                  const enabled = visible.includes(id);
                  const index = visible.indexOf(id);
                  const move = (delta: number) => {
                    const target = visible[index + delta];
                    if (target) useDashboardLayoutStore.getState().move(scope, id, target, delta > 0, ids);
                  };
                  return (
                    <div key={id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                      <Field className="flex min-w-0 flex-1 items-center gap-2">
                        <Checkbox
                          checked={enabled}
                          onChange={(checked) => useDashboardLayoutStore.getState().setVisible(scope, id, checked)}
                          className="group flex size-4 shrink-0 items-center justify-center rounded border border-border data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <Check size={12} className="invisible group-data-checked:visible" />
                        </Checkbox>
                        <Label className="min-w-0 cursor-pointer truncate text-sm" title={widget.label}>{widget.label}</Label>
                      </Field>
                      <Button variant="ghost" size="sm" disabled={!enabled || index === 0} onClick={() => move(-1)} aria-label={`${zh ? "上移" : "Move up"} ${widget.label}`}>
                        <ArrowUp size={13} />
                      </Button>
                      <Button variant="ghost" size="sm" disabled={!enabled || index === visible.length - 1} onClick={() => move(1)} aria-label={`${zh ? "下移" : "Move down"} ${widget.label}`}>
                        <ArrowDown size={13} />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button onClick={onClose}>{zh ? "完成" : "Done"}</Button>
          </DialogFooter>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
