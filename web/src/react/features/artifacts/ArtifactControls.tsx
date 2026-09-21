import { useId } from "react";
import type { ArtifactControl } from "../../../../../api/services/agent-runtime/artifacts/contracts";
export function ArtifactControls({
  controls,
  values,
  onChange,
  disabled = false,
}: {
  controls: ArtifactControl[];
  values: Record<string, unknown>;
  onChange: (control: ArtifactControl, value: unknown) => void;
  disabled?: boolean;
}) {
  const prefix = useId();
  return (
    <div className="artifact-controls">
      {controls.map((control) => {
        const id = `${prefix}-${control.key}`;
        const value = values[control.key] ?? control.defaultValue;
        return (
          <label className="artifact-control" key={control.key} htmlFor={id}>
            <span>{control.label}</span>
            {control.type === "select" ? (
              <select
                id={id}
                aria-label={control.label}
                value={String(value)}
                disabled={disabled}
                onChange={(e) => onChange(control, e.target.value)}
              >
                {control.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : control.type === "toggle" ? (
              <input
                id={id}
                aria-label={control.label}
                type="checkbox"
                checked={value === true}
                disabled={disabled}
                onChange={(e) => onChange(control, e.target.checked)}
              />
            ) : (
              <>
                <input
                  id={id}
                  aria-label={control.label}
                  type={control.type}
                  value={String(value)}
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  maxLength={2000}
                  disabled={disabled}
                  onChange={(e) => {
                    if (
                      (control.type === "number" || control.type === "range") &&
                      e.target.value === ""
                    )
                      return;
                    onChange(
                      control,
                      control.type === "number" || control.type === "range"
                        ? Number(e.target.value)
                        : e.target.value,
                    );
                  }}
                />
                {control.type === "range" && (
                  <output htmlFor={id}>{String(value)}</output>
                )}
              </>
            )}
          </label>
        );
      })}
    </div>
  );
}
