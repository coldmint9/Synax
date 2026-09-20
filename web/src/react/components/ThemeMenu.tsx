import { Button, Dropdown, Label } from "@heroui/react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useShellStore } from "../state/shellStore";
import { useLocale } from "../../hooks/useLocale";

export function ThemeMenu() {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const mode = useShellStore((s) => s.preferences.theme);
  const setTheme = useShellStore((s) => s.setTheme);
  const modes = [
    { id: "light", label: zh ? "浅色" : "Light", Icon: Sun },
    { id: "dark", label: zh ? "深色" : "Dark", Icon: Moon },
    { id: "system", label: zh ? "跟随系统" : "System", Icon: Monitor },
  ] as const;
  const current = modes.find((item) => item.id === mode) ?? modes[2];
  return (
    <Dropdown>
      <Button
        isIconOnly
        variant="ghost"
        className="wh-btn"
        aria-label={`${zh ? "明暗模式" : "Color mode"}: ${current.label}`}
      >
        <current.Icon size={15} />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={zh ? "明暗模式" : "Color mode"}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([mode])}
          onAction={(key) => {
            const option = modes.find((item) => item.id === key);
            if (option) setTheme(option.id);
          }}
        >
          {modes.map(({ id, label, Icon }) => (
            <Dropdown.Item key={id} id={id} textValue={label}>
              <Icon size={14} />
              <Label>{label}</Label>
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
