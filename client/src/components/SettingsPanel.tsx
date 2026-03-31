import { useCallback, useMemo, useState } from "react";
import { fetchModelsList } from "../apiModels";
import type { ApiPreset, GlobalSettings, JudgeConfig, ModelEntry } from "../types";
import { newId } from "../store";
import { ModelPresetPicker } from "./ModelPresetPicker";

interface Props {
  settings: GlobalSettings;
  onChange: (s: GlobalSettings) => void;
}

function remapAfterRemovePreset(
  s: GlobalSettings,
  removedId: string,
  fallbackId: string,
): GlobalSettings {
  return {
    ...s,
    models: s.models.map((m) =>
      m.presetId === removedId ? { ...m, presetId: fallbackId } : m,
    ),
    judges: s.judges.map((j) =>
      j.presetId === removedId ? { ...j, presetId: fallbackId } : j,
    ),
    aggregator:
      s.aggregator.presetId === removedId
        ? { ...s.aggregator, presetId: fallbackId }
        : s.aggregator,
  };
}

export function SettingsPanel({ settings, onChange }: Props) {
  const patch = (p: Partial<GlobalSettings>) =>
    onChange({ ...settings, ...p });

  const setModels = (models: ModelEntry[]) => patch({ models });
  const setJudges = (judges: JudgeConfig[]) => patch({ judges });

  const [modelsByPreset, setModelsByPreset] = useState<
    Record<string, string[]>
  >({});
  const [fetchingPresetId, setFetchingPresetId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  /** 各预设下「手动添加」输入框草稿 */
  const [manualDraftByPreset, setManualDraftByPreset] = useState<
    Record<string, string>
  >({});

  const firstPresetId = settings.apiPresets[0]?.id ?? "";

  /** 拉取列表 + 手动保存的 ID 合并（供下拉框） */
  const mergedModelsByPreset = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const p of settings.apiPresets) {
      const fetched = modelsByPreset[p.id] ?? [];
      const manual = p.manualModelIds ?? [];
      out[p.id] = [...new Set([...manual, ...fetched])].sort((a, b) =>
        a.localeCompare(b),
      );
    }
    return out;
  }, [settings.apiPresets, modelsByPreset]);

  const fetchForPreset = useCallback(
    async (presetId: string) => {
      const p = settings.apiPresets.find((x) => x.id === presetId);
      if (!p) return;
      setFetchingPresetId(presetId);
      setFetchError(null);
      try {
        const ids = await fetchModelsList(p.baseUrl, p.apiKey);
        setModelsByPreset((prev) => ({ ...prev, [presetId]: ids }));
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : String(e));
      } finally {
        setFetchingPresetId(null);
      }
    },
    [settings.apiPresets],
  );

  const updatePreset = (idx: number, next: ApiPreset) => {
    const list = [...settings.apiPresets];
    list[idx] = next;
    patch({ apiPresets: list });
  };

  const addPreset = () => {
    patch({
      apiPresets: [
        ...settings.apiPresets,
        {
          id: newId(),
          name: `预设 ${settings.apiPresets.length + 1}`,
          baseUrl: "https://api.openai.com",
          apiKey: "",
          manualModelIds: [],
          concurrency: 4,
        },
      ],
    });
  };

  const addManualModelId = (presetIdx: number) => {
    const preset = settings.apiPresets[presetIdx];
    if (!preset) return;
    const raw = (manualDraftByPreset[preset.id] ?? "").trim();
    if (!raw) return;
    const nextManual = [...(preset.manualModelIds ?? [])];
    if (!nextManual.includes(raw)) nextManual.push(raw);
    nextManual.sort((a, b) => a.localeCompare(b));
    updatePreset(presetIdx, { ...preset, manualModelIds: nextManual });
    setManualDraftByPreset((d) => ({ ...d, [preset.id]: "" }));
  };

  const removeManualModelId = (presetIdx: number, modelId: string) => {
    const preset = settings.apiPresets[presetIdx];
    if (!preset) return;
    updatePreset(presetIdx, {
      ...preset,
      manualModelIds: (preset.manualModelIds ?? []).filter((x) => x !== modelId),
    });
  };

  const removePreset = (id: string) => {
    if (settings.apiPresets.length <= 1) return;
    const rest = settings.apiPresets.filter((p) => p.id !== id);
    const fb = rest[0]?.id ?? "";
    onChange({
      ...remapAfterRemovePreset(settings, id, fb),
      apiPresets: rest,
    });
  };

  return (
    <div className="panel">
      <h2>设置</h2>
      <p className="muted">
        配置与评测结果保存在本机浏览器 localStorage；清除站点数据会丢失。
      </p>

      <h3 className="section-title">API 预设</h3>
      <p className="muted small">
        为不同厂商分别配置名称、Base URL、Key 与并发上限；同一预设下的参赛 / Judge
        / 汇总请求共享该上限。「获取模型列表」或「手动添加模型
        ID」会合并进该预设的可选列表，再在下方的参赛模型 / Judge / 汇总中选择。
      </p>
      {fetchError && <p className="err fetch-err">{fetchError}</p>}
      {settings.apiPresets.map((preset, idx) => (
        <div key={preset.id} className="preset-card">
          <div className="row">
            <div className="field">
              <label>预设名称</label>
              <input
                value={preset.name}
                onChange={(e) =>
                  updatePreset(idx, { ...preset, name: e.target.value })
                }
                placeholder="例如：OpenAI 官方"
              />
            </div>
            <div className="field flex-grow">
              <label>Base URL（OpenAI 兼容）</label>
              <input
                value={preset.baseUrl}
                onChange={(e) =>
                  updatePreset(idx, { ...preset, baseUrl: e.target.value })
                }
                placeholder="https://api.openai.com"
              />
            </div>
          </div>
          <div className="row">
            <div className="field flex-grow">
              <label>API Key</label>
              <input
                type="password"
                autoComplete="off"
                value={preset.apiKey}
                onChange={(e) =>
                  updatePreset(idx, { ...preset, apiKey: e.target.value })
                }
                placeholder="sk-..."
              />
            </div>
            <div className="field preset-actions">
              <label>模型列表</label>
              <div className="preset-actions-inner">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={fetchingPresetId === preset.id}
                  onClick={() => fetchForPreset(preset.id)}
                >
                  {fetchingPresetId === preset.id
                    ? "获取中…"
                    : "获取模型列表"}
                </button>
                <span className="muted small">
                  拉取 {(modelsByPreset[preset.id] ?? []).length} · 手输{" "}
                  {(preset.manualModelIds ?? []).length} · 合计可选{" "}
                  {(mergedModelsByPreset[preset.id] ?? []).length}
                </span>
              </div>
            </div>
            <div className="field" style={{ flex: "0 0 120px" }}>
              <label>并发上限</label>
              <input
                type="number"
                min={1}
                max={64}
                value={preset.concurrency}
                onChange={(e) =>
                  updatePreset(idx, {
                    ...preset,
                    concurrency: Math.max(1, Number(e.target.value) || 1),
                  })
                }
              />
            </div>
            {settings.apiPresets.length > 1 && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => removePreset(preset.id)}
              >
                删除预设
              </button>
            )}
          </div>
          <div className="row manual-model-row">
            <div className="field flex-grow">
              <label>手动添加模型 ID（保存进该预设列表）</label>
              <div className="model-select-row">
                <input
                  value={manualDraftByPreset[preset.id] ?? ""}
                  onChange={(e) =>
                    setManualDraftByPreset((d) => ({
                      ...d,
                      [preset.id]: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addManualModelId(idx);
                    }
                  }}
                  placeholder="例如 my-vendor-model-001"
                />
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => addManualModelId(idx)}
                >
                  加入列表
                </button>
              </div>
            </div>
          </div>
          {(preset.manualModelIds ?? []).length > 0 && (
            <ul className="manual-model-tags">
              {(preset.manualModelIds ?? []).map((mid) => (
                <li key={mid}>
                  <code>{mid}</code>
                  <button
                    type="button"
                    className="btn-tag-remove"
                    title="从手输列表移除"
                    onClick={() => removeManualModelId(idx, mid)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <button type="button" className="btn-ghost" onClick={addPreset}>
        + 添加 API 预设
      </button>

      <div className="row">
        <div className="field">
          <label>temperature（留空不传）</label>
          <input
            type="number"
            step={0.1}
            min={0}
            max={2}
            value={settings.temperature === undefined ? "" : settings.temperature}
            placeholder="默认由上游决定"
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") {
                patch({ temperature: undefined });
                return;
              }
              const n = Number(v);
              if (!Number.isNaN(n)) patch({ temperature: n });
            }}
          />
        </div>
        <div className="field">
          <label>max_tokens（留空不传）</label>
          <input
            type="number"
            min={1}
            value={settings.maxTokens === undefined ? "" : settings.maxTokens}
            placeholder="默认由上游决定"
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") {
                patch({ maxTokens: undefined });
                return;
              }
              const n = Number(v);
              if (!Number.isNaN(n)) patch({ maxTokens: n });
            }}
          />
        </div>
        <div className="field">
          <label>top_p（留空不传）</label>
          <input
            type="number"
            step={0.05}
            min={0}
            max={1}
            value={settings.topP === undefined ? "" : settings.topP}
            placeholder="默认由上游决定"
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") {
                patch({ topP: undefined });
                return;
              }
              const n = Number(v);
              if (!Number.isNaN(n)) patch({ topP: n });
            }}
          />
        </div>
      </div>

      <h3 className="section-title">参赛模型</h3>
      {settings.models.map((m, idx) => (
        <div key={m.id} className="model-entry-card">
          <div className="row align-stretch">
            <div className="field-grow">
              <ModelPresetPicker
                presets={settings.apiPresets}
                presetId={m.presetId}
                modelId={m.modelId}
                modelsByPreset={mergedModelsByPreset}
                onPresetChange={(presetId) => {
                  const next = [...settings.models];
                  next[idx] = { ...m, presetId };
                  setModels(next);
                }}
                onModelChange={(modelId) => {
                  const next = [...settings.models];
                  next[idx] = { ...m, modelId };
                  setModels(next);
                }}
                onRefreshModels={() => fetchForPreset(m.presetId)}
                refreshPending={fetchingPresetId === m.presetId}
              />
            </div>
            <div className="field" style={{ flex: "0 0 120px" }}>
              <label>重复次数 n</label>
              <input
                type="number"
                min={1}
                max={50}
                value={m.sampleCount}
                onChange={(e) => {
                  const next = [...settings.models];
                  next[idx] = {
                    ...m,
                    sampleCount: Math.max(1, Number(e.target.value) || 1),
                  };
                  setModels(next);
                }}
              />
            </div>
            <button
              type="button"
              className="btn-ghost align-self-end"
              onClick={() =>
                setModels(settings.models.filter((x) => x.id !== m.id))
              }
            >
              删除
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="btn-ghost"
        onClick={() =>
          setModels([
            ...settings.models,
            {
              id: newId(),
              presetId: firstPresetId,
              modelId: "",
              sampleCount: 1,
            },
          ])
        }
      >
        + 添加模型
      </button>

      <h3 className="section-title">Judge 列表</h3>
      {settings.judges.map((j, idx) => (
        <div key={j.id} className="judge-card">
          <div className="row">
            <div className="field">
              <label>名称</label>
              <input
                value={j.name}
                onChange={(e) => {
                  const next = [...settings.judges];
                  next[idx] = { ...j, name: e.target.value };
                  setJudges(next);
                }}
              />
            </div>
            <button
              type="button"
              className="btn-ghost align-self-end"
              onClick={() =>
                setJudges(settings.judges.filter((x) => x.id !== j.id))
              }
            >
              删除
            </button>
          </div>
          <div className="row align-stretch">
            <div className="field-grow">
              <ModelPresetPicker
                presets={settings.apiPresets}
                presetId={j.presetId}
                modelId={j.model}
                modelsByPreset={mergedModelsByPreset}
                onPresetChange={(presetId) => {
                  const next = [...settings.judges];
                  next[idx] = { ...j, presetId };
                  setJudges(next);
                }}
                onModelChange={(model) => {
                  const next = [...settings.judges];
                  next[idx] = { ...j, model };
                  setJudges(next);
                }}
                onRefreshModels={() => fetchForPreset(j.presetId)}
                refreshPending={fetchingPresetId === j.presetId}
              />
            </div>
            <div className="field" style={{ flex: "0 0 100px" }}>
              <label>review 次数</label>
              <input
                type="number"
                min={1}
                max={20}
                value={j.reviewCount}
                onChange={(e) => {
                  const next = [...settings.judges];
                  next[idx] = {
                    ...j,
                    reviewCount: Math.max(1, Number(e.target.value) || 1),
                  };
                  setJudges(next);
                }}
              />
            </div>
          </div>
          <div className="field">
            <label>system</label>
            <textarea
              value={j.systemPrompt}
              onChange={(e) => {
                const next = [...settings.judges];
                next[idx] = { ...j, systemPrompt: e.target.value };
                setJudges(next);
              }}
            />
          </div>
          <div className="field">
            <label>user 模板（{"{{candidate}}"} 为模型对该题的候选回答）</label>
            <textarea
              value={j.userPromptTemplate}
              onChange={(e) => {
                const next = [...settings.judges];
                next[idx] = { ...j, userPromptTemplate: e.target.value };
                setJudges(next);
              }}
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        className="btn-ghost"
        onClick={() =>
          setJudges([
            ...settings.judges,
            {
              id: newId(),
              name: "新评委",
              presetId: firstPresetId,
              model: "",
              systemPrompt:
                "你是向量检索与系统架构方向的评测专家。候选内容应针对「向量数据库 / ANN 近似最近邻」类算法与系统设计题。请从：问题边界是否清晰、索引与数据结构选型、插入/查询/更新的复杂度与量级、并行与分片、延迟与吞吐权衡、增量更新与可运维性等维度分析。先用自然语言分条写出分析，最后单独一行「综合分：X/10」（X 为 0–10）。",
              userPromptTemplate:
                "下面是对「向量数据库 / ANN 检索、性能优先」设计题的回答，请按 system 要求评价。\n\n【候选回答】\n{{candidate}}",
              reviewCount: 1,
            },
          ])
        }
      >
        + 添加 Judge
      </button>

      <h3 className="section-title">汇总模型</h3>
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={settings.aggregator.enabled}
            onChange={(e) =>
              patch({
                aggregator: {
                  ...settings.aggregator,
                  enabled: e.target.checked,
                },
              })
            }
          />{" "}
          启用汇总（全链路流式）
        </label>
      </div>
      <div className="aggregator-card">
        <ModelPresetPicker
          presets={settings.apiPresets}
          presetId={settings.aggregator.presetId}
          modelId={settings.aggregator.model}
          modelsByPreset={mergedModelsByPreset}
          onPresetChange={(presetId) =>
            patch({
              aggregator: { ...settings.aggregator, presetId },
            })
          }
          onModelChange={(model) =>
            patch({
              aggregator: { ...settings.aggregator, model },
            })
          }
          onRefreshModels={() =>
            fetchForPreset(settings.aggregator.presetId)
          }
          refreshPending={
            fetchingPresetId === settings.aggregator.presetId
          }
        />
        <div className="field">
          <label>system</label>
          <textarea
            value={settings.aggregator.systemPrompt}
            onChange={(e) =>
              patch({
                aggregator: {
                  ...settings.aggregator,
                  systemPrompt: e.target.value,
                },
              })
            }
          />
        </div>
        <div className="field">
          <label>
            user 模板（{"{{candidate}}"}、{"{{reviews}}"}）
          </label>
          <textarea
            value={settings.aggregator.userPromptTemplate}
            onChange={(e) =>
              patch({
                aggregator: {
                  ...settings.aggregator,
                  userPromptTemplate: e.target.value,
                },
              })
            }
          />
        </div>
      </div>
    </div>
  );
}
