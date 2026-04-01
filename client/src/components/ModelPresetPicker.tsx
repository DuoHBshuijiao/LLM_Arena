import { useId, useMemo } from "react";
import type { ApiPreset } from "../types";
import { CustomSelect } from "./CustomSelect";

const MODEL_PLACEHOLDER = { value: "", label: "请选择模型…" };

interface Props {
  presets: ApiPreset[];
  presetId: string;
  modelId: string;
  /** 各预设下已拉取的模型 ID（由父组件在「获取模型列表」后写入） */
  modelsByPreset: Record<string, string[]>;
  onPresetChange: (presetId: string) => void;
  onModelChange: (modelId: string) => void;
  /** 针对当前预设再次拉取列表 */
  onRefreshModels?: () => void;
  refreshPending?: boolean;
}

export function ModelPresetPicker({
  presets,
  presetId,
  modelId,
  modelsByPreset,
  onPresetChange,
  onModelChange,
  onRefreshModels,
  refreshPending,
}: Props) {
  const uid = useId().replace(/:/g, "");
  const presetSelectId = `${uid}-preset`;
  const modelSelectId = `${uid}-model`;
  const list = modelsByPreset[presetId] ?? [];
  const missing = Boolean(modelId.trim() && !list.includes(modelId));

  const presetOptions = useMemo(
    () => presets.map((p) => ({ value: p.id, label: p.name })),
    [presets],
  );

  const modelOptions = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    if (missing) {
      out.push({
        value: modelId,
        label: `${modelId}（当前值，未在已拉取列表中）`,
      });
    }
    for (const id of list) {
      out.push({ value: id, label: id });
    }
    return out;
  }, [list, missing, modelId]);

  return (
    <div className="model-preset-picker">
      <div className="field">
        <label htmlFor={presetSelectId}>API 预设</label>
        <CustomSelect
          id={presetSelectId}
          value={presetId}
          onChange={onPresetChange}
          options={presetOptions}
        />
      </div>
      <div className="field flex-grow">
        <label htmlFor={modelSelectId}>模型</label>
        <div className="model-select-row">
          <CustomSelect
            id={modelSelectId}
            value={modelId}
            onChange={onModelChange}
            options={modelOptions}
            placeholderOption={MODEL_PLACEHOLDER}
          />
          {onRefreshModels && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={refreshPending}
              onClick={onRefreshModels}
            >
              {refreshPending ? "获取中…" : "刷新列表"}
            </button>
          )}
        </div>
        {list.length === 0 && !missing && (
          <p className="hint-inline">
            请在上方对应预设中「获取模型列表」并在弹层中勾选确认，或「手动添加模型
            ID」。
          </p>
        )}
      </div>
    </div>
  );
}
