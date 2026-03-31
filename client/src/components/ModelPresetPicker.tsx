import type { ApiPreset } from "../types";

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
  const list = modelsByPreset[presetId] ?? [];
  const missing = Boolean(modelId.trim() && !list.includes(modelId));

  return (
    <div className="model-preset-picker">
      <div className="field">
        <label>API 预设</label>
        <select
          value={presetId}
          onChange={(e) => onPresetChange(e.target.value)}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field flex-grow">
        <label>模型</label>
        <div className="model-select-row">
          <select
            value={modelId}
            onChange={(e) => onModelChange(e.target.value)}
          >
            <option value="">请选择模型…</option>
            {missing && (
              <option value={modelId}>
                {modelId}（当前值，未在已拉取列表中）
              </option>
            )}
            {list.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
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
            请在上方对应预设中「获取模型列表」或「手动添加模型 ID」。
          </p>
        )}
      </div>
    </div>
  );
}
