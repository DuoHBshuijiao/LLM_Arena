import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { fetchModelsList } from "../apiModels";
import {
  addCustomEvaluationPreset,
  applyEvaluationPreset,
  clearJudgePromptsForCurrentPresetIf,
  customEvaluationPresetsSafe,
  deleteCustomEvaluationPreset,
  getEvaluationPresetSelectOptions,
  getDefaultJudgePromptTemplatesForSettings,
  getEvaluationThemeLabel,
  updateCustomEvaluationPresetName,
} from "../evaluationPresets";
import type { ApiPreset, GlobalSettings, JudgeConfig, ModelEntry } from "../types";
import { newId, useArenaStore } from "../store";
import {
  applyFetchedSelection,
  ModelFetchPickerModal,
} from "./ModelFetchPickerModal";
import { ConfirmModal } from "./ConfirmModal";
import { CustomSelect } from "./CustomSelect";
import { ModelPresetPicker } from "./ModelPresetPicker";

interface Props {
  settings: GlobalSettings;
  onChange: (s: GlobalSettings) => void;
}

type DeleteConfirmState =
  | null
  | { kind: "customEval"; id: string; label: string }
  | { kind: "apiPreset"; id: string; label: string }
  | { kind: "judge"; id: string; label: string };

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
  const fid = useId().replace(/:/g, "");
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const patch = (p: Partial<GlobalSettings>) =>
    onChange({ ...settings, ...p });

  const setModels = (models: ModelEntry[]) => patch({ models });
  const setJudges = (judges: JudgeConfig[]) => patch({ judges });

  const [fetchingPresetId, setFetchingPresetId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  /** 拉取成功后弹出选择器，确认后再写入 fetchedModelIds */
  const [fetchPicker, setFetchPicker] = useState<{
    presetId: string;
    remoteIds: string[];
    key: string;
  } | null>(null);
  /** 各预设下「手动添加」输入框草稿 */
  const [manualDraftByPreset, setManualDraftByPreset] = useState<
    Record<string, string>
  >({});
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>(null);
  const [selectedApiPresetId, setSelectedApiPresetId] = useState("");
  const [selectedJudgeId, setSelectedJudgeId] = useState("");

  useEffect(() => {
    const ids = settings.apiPresets.map((p) => p.id);
    if (ids.length === 0) return;
    setSelectedApiPresetId((cur) => (cur && ids.includes(cur) ? cur : ids[0]));
  }, [settings.apiPresets]);

  useEffect(() => {
    const ids = settings.judges.map((j) => j.id);
    if (ids.length === 0) return;
    setSelectedJudgeId((cur) => (cur && ids.includes(cur) ? cur : ids[0]));
  }, [settings.judges]);

  const customEvalNameAtFocusRef = useRef<Record<string, string>>({});

  const customEvalList = customEvaluationPresetsSafe(settings);
  const evalPresetSelectOptions = useMemo(
    () => getEvaluationPresetSelectOptions(customEvalList, "paren"),
    [customEvalList],
  );

  const firstPresetId = settings.apiPresets[0]?.id ?? "";

  const selectedApiIdx = settings.apiPresets.findIndex(
    (p) => p.id === selectedApiPresetId,
  );
  const selectedJudgeIdx = settings.judges.findIndex(
    (j) => j.id === selectedJudgeId,
  );
  const selectedApiPreset =
    selectedApiIdx >= 0 ? settings.apiPresets[selectedApiIdx] : null;
  const selectedJudge =
    selectedJudgeIdx >= 0 ? settings.judges[selectedJudgeIdx] : null;

  /** 拉取列表 + 手动保存的 ID 合并（供下拉框） */
  const mergedModelsByPreset = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const p of settings.apiPresets) {
      const fetched = p.fetchedModelIds ?? [];
      const manual = p.manualModelIds ?? [];
      out[p.id] = [...new Set([...manual, ...fetched])].sort((a, b) =>
        a.localeCompare(b),
      );
    }
    return out;
  }, [settings.apiPresets]);

  const updatePreset = (idx: number, next: ApiPreset) => {
    const list = [...settings.apiPresets];
    list[idx] = next;
    patch({ apiPresets: list });
  };

  const fetchForPreset = useCallback(
    async (presetId: string) => {
      const idx = settings.apiPresets.findIndex((x) => x.id === presetId);
      const p = settings.apiPresets[idx];
      if (!p || idx < 0) return;
      setFetchingPresetId(presetId);
      setFetchError(null);
      try {
        const ids = await fetchModelsList(p.baseUrl, p.apiKey);
        const s = useArenaStore.getState().settings;
        const i = s.apiPresets.findIndex((x) => x.id === presetId);
        if (i < 0) return;
        setFetchPicker({
          presetId,
          remoteIds: ids,
          key: crypto.randomUUID(),
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          setFetchError("请求超时或已中断，请稍后重试。");
        } else {
          const raw = e instanceof Error ? e.message : String(e);
          const msg =
            raw.trim().length > 900 ? `${raw.trim().slice(0, 900)}…` : raw;
          setFetchError(msg || "获取失败，请重试。");
        }
      } finally {
        setFetchingPresetId(null);
      }
    },
    [settings.apiPresets, onChange],
  );

  const confirmFetchPicker = useCallback(
    (selectedFromRemote: string[]) => {
      if (!fetchPicker) return;
      const s = useArenaStore.getState().settings;
      const idx = s.apiPresets.findIndex((x) => x.id === fetchPicker.presetId);
      if (idx < 0) {
        setFetchPicker(null);
        return;
      }
      const p = s.apiPresets[idx];
      const nextFetched = applyFetchedSelection(
        p.fetchedModelIds ?? [],
        fetchPicker.remoteIds,
        selectedFromRemote,
      );
      const list = [...s.apiPresets];
      list[idx] = { ...p, fetchedModelIds: nextFetched };
      onChange({ ...s, apiPresets: list });
      setFetchPicker(null);
    },
    [fetchPicker, onChange],
  );

  const addPreset = () => {
    const id = newId();
    patch({
      apiPresets: [
        ...settings.apiPresets,
        {
          id,
          name: `预设 ${settings.apiPresets.length + 1}`,
          baseUrl: "https://api.openai.com",
          apiKey: "",
          manualModelIds: [],
          fetchedModelIds: [],
          concurrency: 4,
        },
      ],
    });
    setSelectedApiPresetId(id);
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

  /** 从手动列表与拉取列表中同时移除（标签与下拉共用合并结果） */
  const removePresetModelId = (presetIdx: number, modelId: string) => {
    const preset = settings.apiPresets[presetIdx];
    if (!preset) return;
    updatePreset(presetIdx, {
      ...preset,
      manualModelIds: (preset.manualModelIds ?? []).filter((x) => x !== modelId),
      fetchedModelIds: (preset.fetchedModelIds ?? []).filter(
        (x) => x !== modelId,
      ),
    });
  };

  const removePreset = useCallback((id: string) => {
    const s = useArenaStore.getState().settings;
    if (s.apiPresets.length <= 1) return;
    const rest = s.apiPresets.filter((p) => p.id !== id);
    const fb = rest[0]?.id ?? "";
    onChange({
      ...remapAfterRemovePreset(s, id, fb),
      apiPresets: rest,
    });
  }, [onChange]);

  const confirmPendingDelete = useCallback(() => {
    if (!deleteConfirm) return;
    const s = useArenaStore.getState().settings;
    if (deleteConfirm.kind === "customEval") {
      onChange(deleteCustomEvaluationPreset(s, deleteConfirm.id));
    } else if (deleteConfirm.kind === "apiPreset") {
      removePreset(deleteConfirm.id);
    } else {
      onChange({
        ...s,
        judges: s.judges.filter((x) => x.id !== deleteConfirm.id),
      });
    }
    setDeleteConfirm(null);
  }, [deleteConfirm, onChange, removePreset]);

  return (
    <div className="settings-page">
      <div className="settings-main-card">
        <header className="settings-main-card__head">
          <h2 className="settings-main-card__title">设置</h2>
          <p className="settings-main-card__lede muted">
            配置与评测结果保存在本机浏览器 localStorage；清除站点数据会丢失。
          </p>
        </header>

        <div className="settings-cols">
          <div className="settings-col">
            <h3 className="settings-section-title">
              {getEvaluationThemeLabel(
                settings.evaluationPresetId,
                customEvalList,
              )}{" "}
              · 预设题目
            </h3>
            <p className="muted small settings-prose">
              与「运行与结果」页共用同一选项。切换内置题将更新题目并载入该家族默认评委模板；切换自定义题会清空评委已填模板。汇总模型的
              system/user 提示词不会随题目切换被覆盖。
            </p>
            <div className="field">
              <label htmlFor="eval-preset-select">预设题目</label>
              <CustomSelect
                id="eval-preset-select"
                value={settings.evaluationPresetId}
                onChange={(v) => onChange(applyEvaluationPreset(settings, v))}
                options={evalPresetSelectOptions}
              />
            </div>
            <div className="field eval-custom-presets">
              <div className="eval-custom-presets__row">
                <span className="muted small">自定义题目</span>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => onChange(addCustomEvaluationPreset(settings))}
                >
                  添加自定义题目
                </button>
              </div>
              {customEvalList.length > 0 && (
                <ul className="eval-custom-presets__list">
                  {customEvalList.map((c) => (
                    <li key={c.id} className="eval-custom-presets__item">
                      <input
                        type="text"
                        className="eval-custom-presets__name"
                        aria-label={`自定义题目名称：${c.name}`}
                        value={c.name}
                        onFocus={() => {
                          customEvalNameAtFocusRef.current[c.id] = c.name;
                        }}
                        onChange={(e) =>
                          onChange(
                            updateCustomEvaluationPresetName(
                              settings,
                              c.id,
                              e.target.value,
                            ),
                          )
                        }
                        onBlur={(e) => {
                          const prev = customEvalNameAtFocusRef.current[c.id];
                          if (prev === undefined) return;
                          if (e.target.value !== prev) {
                            onChange(
                              clearJudgePromptsForCurrentPresetIf(
                                settingsRef.current,
                                c.id,
                              ),
                            );
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        aria-label={`删除自定义题目「${c.name}」`}
                        onClick={() =>
                          setDeleteConfirm({
                            kind: "customEval",
                            id: c.id,
                            label: c.name,
                          })
                        }
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <h3 className="settings-section-title">采样参数</h3>
            <p className="muted small settings-prose">
              留空则请求中不传该字段，由上游默认行为决定。
            </p>
            <div className="row">
              <div className="field">
                <label htmlFor={`${fid}-temperature`}>
                  temperature（留空不传）
                </label>
                <input
                  id={`${fid}-temperature`}
                  type="number"
                  step={0.1}
                  min={0}
                  max={2}
                  value={
                    settings.temperature === undefined ? "" : settings.temperature
                  }
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
                <label htmlFor={`${fid}-max-tokens`}>
                  max_tokens（留空不传）
                </label>
                <input
                  id={`${fid}-max-tokens`}
                  type="number"
                  min={1}
                  value={
                    settings.maxTokens === undefined ? "" : settings.maxTokens
                  }
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
                <label htmlFor={`${fid}-top-p`}>top_p（留空不传）</label>
                <input
                  id={`${fid}-top-p`}
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
          </div>

          <div className="settings-col">
            <h3 className="settings-section-title">API 预设</h3>
            <p className="muted small settings-prose">
              为不同厂商分别配置名称、Base URL、Key 与并发上限；同一预设下的参赛 /
              Judge / 汇总请求共享该上限。「获取模型列表」会在弹层中展示上游返回的
              ID，可搜索并勾选后确认写入；「手动添加模型 ID」直接写入。两者合并为该预设的可选列表，再在本栏与右栏中选择。
            </p>
            {fetchError && (
              <p className="err fetch-err fetch-err--block" role="alert">
                {fetchError}
              </p>
            )}
            <div className="settings-config-box">
              <div
                className="settings-config-box__list"
                role="listbox"
                aria-label="API 预设列表"
              >
                {settings.apiPresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="option"
                    aria-selected={selectedApiPresetId === preset.id}
                    className={
                      selectedApiPresetId === preset.id
                        ? "settings-config-box__item settings-config-box__item--active"
                        : "settings-config-box__item"
                    }
                    onClick={() => setSelectedApiPresetId(preset.id)}
                  >
                    <span className="settings-config-box__item-label">
                      {preset.name.trim() ? preset.name : "未命名预设"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="settings-config-box__add-row">
                <button type="button" className="btn-ghost" onClick={addPreset}>
                  + 添加 API 预设
                </button>
              </div>
              {selectedApiPreset && selectedApiIdx >= 0 ? (
                <div className="settings-config-box__detail">
                  <div className="settings-preset settings-preset--single">
                    <div className="row">
                      <div className="field">
                        <label htmlFor={`${fid}-preset-name-${selectedApiPreset.id}`}>
                          预设名称
                        </label>
                        <input
                          id={`${fid}-preset-name-${selectedApiPreset.id}`}
                          value={selectedApiPreset.name}
                          onChange={(e) =>
                            updatePreset(selectedApiIdx, {
                              ...selectedApiPreset,
                              name: e.target.value,
                            })
                          }
                          placeholder="例如：OpenAI 官方"
                        />
                      </div>
                      <div className="field flex-grow">
                        <label htmlFor={`${fid}-preset-base-${selectedApiPreset.id}`}>
                          Base URL（OpenAI 兼容）
                        </label>
                        <input
                          id={`${fid}-preset-base-${selectedApiPreset.id}`}
                          value={selectedApiPreset.baseUrl}
                          onChange={(e) =>
                            updatePreset(selectedApiIdx, {
                              ...selectedApiPreset,
                              baseUrl: e.target.value,
                            })
                          }
                          placeholder="https://api.openai.com"
                        />
                      </div>
                    </div>
                    <div className="row">
                      <div className="field flex-grow">
                        <label htmlFor={`${fid}-preset-key-${selectedApiPreset.id}`}>
                          API Key
                        </label>
                        <input
                          id={`${fid}-preset-key-${selectedApiPreset.id}`}
                          type="password"
                          autoComplete="off"
                          value={selectedApiPreset.apiKey}
                          onChange={(e) =>
                            updatePreset(selectedApiIdx, {
                              ...selectedApiPreset,
                              apiKey: e.target.value,
                            })
                          }
                          placeholder="sk-..."
                        />
                      </div>
                      <div className="field preset-actions">
                        <label htmlFor={`${fid}-preset-fetch-${selectedApiPreset.id}`}>
                          模型列表
                        </label>
                        <div className="preset-actions-inner">
                          <button
                            id={`${fid}-preset-fetch-${selectedApiPreset.id}`}
                            type="button"
                            className="btn-primary"
                            disabled={fetchingPresetId === selectedApiPreset.id}
                            onClick={() => fetchForPreset(selectedApiPreset.id)}
                          >
                            {fetchingPresetId === selectedApiPreset.id
                              ? "获取中…"
                              : "获取模型列表"}
                          </button>
                          <span className="muted small">
                            已拉取{" "}
                            {(selectedApiPreset.fetchedModelIds ?? []).length} ·
                            手动 {(selectedApiPreset.manualModelIds ?? []).length}{" "}
                            · 合计可选{" "}
                            {
                              (mergedModelsByPreset[selectedApiPreset.id] ?? [])
                                .length
                            }
                          </span>
                        </div>
                      </div>
                      <div className="field field--fixed-120">
                        <label
                          htmlFor={`${fid}-preset-concurrency-${selectedApiPreset.id}`}
                        >
                          并发上限
                        </label>
                        <input
                          id={`${fid}-preset-concurrency-${selectedApiPreset.id}`}
                          type="number"
                          min={1}
                          max={64}
                          value={selectedApiPreset.concurrency}
                          onChange={(e) =>
                            updatePreset(selectedApiIdx, {
                              ...selectedApiPreset,
                              concurrency: Math.max(
                                1,
                                Number(e.target.value) || 1,
                              ),
                            })
                          }
                        />
                      </div>
                      {settings.apiPresets.length > 1 && (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() =>
                            setDeleteConfirm({
                              kind: "apiPreset",
                              id: selectedApiPreset.id,
                              label: selectedApiPreset.name,
                            })
                          }
                        >
                          删除预设
                        </button>
                      )}
                    </div>
                    <div className="row manual-model-row">
                      <div className="field flex-grow">
                        <label
                          htmlFor={`${fid}-preset-manual-${selectedApiPreset.id}`}
                        >
                          手动添加模型 ID（保存进该预设列表）
                        </label>
                        <div className="model-select-row">
                          <input
                            id={`${fid}-preset-manual-${selectedApiPreset.id}`}
                            value={
                              manualDraftByPreset[selectedApiPreset.id] ?? ""
                            }
                            onChange={(e) =>
                              setManualDraftByPreset((d) => ({
                                ...d,
                                [selectedApiPreset.id]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                addManualModelId(selectedApiIdx);
                              }
                            }}
                            placeholder="例如 my-vendor-model-001"
                          />
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => addManualModelId(selectedApiIdx)}
                          >
                            加入列表
                          </button>
                        </div>
                      </div>
                    </div>
                    {(mergedModelsByPreset[selectedApiPreset.id] ?? []).length >
                      0 && (
                      <ul className="manual-model-tags">
                        {(
                          mergedModelsByPreset[selectedApiPreset.id] ?? []
                        ).map((mid) => (
                          <li key={mid}>
                            <code>{mid}</code>
                            <button
                              type="button"
                              className="btn-tag-remove"
                              title="从该预设可选列表中移除"
                              onClick={() =>
                                removePresetModelId(selectedApiIdx, mid)
                              }
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <h3 className="settings-section-title">参赛模型</h3>
            {settings.models.map((m, idx) => (
              <div key={m.id} className="settings-stack-item">
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
            <div className="field field--fixed-120">
              <label htmlFor={`${fid}-model-sample-${m.id}`}>重复次数 n</label>
              <input
                id={`${fid}-model-sample-${m.id}`}
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
          </div>

          <div className="settings-col">
            <h3 className="settings-section-title">Judge 列表</h3>
            <div className="settings-config-box">
              <div
                className="settings-config-box__list"
                role="listbox"
                aria-label="Judge 列表"
              >
                {settings.judges.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    role="option"
                    aria-selected={selectedJudgeId === j.id}
                    className={
                      selectedJudgeId === j.id
                        ? "settings-config-box__item settings-config-box__item--active"
                        : "settings-config-box__item"
                    }
                    onClick={() => setSelectedJudgeId(j.id)}
                  >
                    <span className="settings-config-box__item-label">
                      {j.name.trim() ? j.name : "未命名评委"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="settings-config-box__add-row">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    const jp =
                      getDefaultJudgePromptTemplatesForSettings(settings);
                    const id = newId();
                    setJudges([
                      ...settings.judges,
                      {
                        id,
                        name: "新评委",
                        presetId: firstPresetId,
                        model: "",
                        systemPrompt: jp.systemPrompt,
                        userPromptTemplate: jp.userPromptTemplate,
                        reviewCount: 1,
                      },
                    ]);
                    setSelectedJudgeId(id);
                  }}
                >
                  + 添加 Judge
                </button>
              </div>
              {selectedJudge && selectedJudgeIdx >= 0 ? (
                <div className="settings-config-box__detail">
                  <div className="settings-stack-item settings-stack-item--single">
                    <div className="row">
                      <div className="field">
                        <label
                          htmlFor={`${fid}-judge-name-${selectedJudge.id}`}
                        >
                          名称
                        </label>
                        <input
                          id={`${fid}-judge-name-${selectedJudge.id}`}
                          value={selectedJudge.name}
                          onChange={(e) => {
                            const next = [...settings.judges];
                            next[selectedJudgeIdx] = {
                              ...selectedJudge,
                              name: e.target.value,
                            };
                            setJudges(next);
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        className="btn-ghost align-self-end"
                        onClick={() =>
                          setDeleteConfirm({
                            kind: "judge",
                            id: selectedJudge.id,
                            label: selectedJudge.name,
                          })
                        }
                      >
                        删除
                      </button>
                    </div>
                    <div className="row align-stretch">
                      <div className="field-grow">
                        <ModelPresetPicker
                          presets={settings.apiPresets}
                          presetId={selectedJudge.presetId}
                          modelId={selectedJudge.model}
                          modelsByPreset={mergedModelsByPreset}
                          onPresetChange={(presetId) => {
                            const next = [...settings.judges];
                            next[selectedJudgeIdx] = {
                              ...selectedJudge,
                              presetId,
                            };
                            setJudges(next);
                          }}
                          onModelChange={(model) => {
                            const next = [...settings.judges];
                            next[selectedJudgeIdx] = { ...selectedJudge, model };
                            setJudges(next);
                          }}
                          onRefreshModels={() =>
                            fetchForPreset(selectedJudge.presetId)
                          }
                          refreshPending={
                            fetchingPresetId === selectedJudge.presetId
                          }
                        />
                      </div>
                      <div className="field field--fixed-100">
                        <label
                          htmlFor={`${fid}-judge-review-${selectedJudge.id}`}
                        >
                          review 次数
                        </label>
                        <input
                          id={`${fid}-judge-review-${selectedJudge.id}`}
                          type="number"
                          min={1}
                          max={20}
                          value={selectedJudge.reviewCount}
                          onChange={(e) => {
                            const next = [...settings.judges];
                            next[selectedJudgeIdx] = {
                              ...selectedJudge,
                              reviewCount: Math.max(
                                1,
                                Number(e.target.value) || 1,
                              ),
                            };
                            setJudges(next);
                          }}
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor={`${fid}-judge-sys-${selectedJudge.id}`}>
                        system
                      </label>
                      <textarea
                        id={`${fid}-judge-sys-${selectedJudge.id}`}
                        value={selectedJudge.systemPrompt}
                        onChange={(e) => {
                          const next = [...settings.judges];
                          next[selectedJudgeIdx] = {
                            ...selectedJudge,
                            systemPrompt: e.target.value,
                          };
                          setJudges(next);
                        }}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`${fid}-judge-user-${selectedJudge.id}`}>
                        user 模板（{"{{candidate}}"} 为模型对该题的候选回答）
                      </label>
                      <textarea
                        id={`${fid}-judge-user-${selectedJudge.id}`}
                        value={selectedJudge.userPromptTemplate}
                        onChange={(e) => {
                          const next = [...settings.judges];
                          next[selectedJudgeIdx] = {
                            ...selectedJudge,
                            userPromptTemplate: e.target.value,
                          };
                          setJudges(next);
                        }}
                      />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <h3 className="settings-section-title">汇总模型</h3>
            <div className="field field--switch">
              <label className="switch-field">
                <input
                  type="checkbox"
                  className="switch-field__input"
                  checked={settings.aggregator.enabled}
                  onChange={(e) =>
                    patch({
                      aggregator: {
                        ...settings.aggregator,
                        enabled: e.target.checked,
                      },
                    })
                  }
                />
                <span className="switch-field__control" aria-hidden="true" />
                <span className="switch-field__text">启用汇总（全链路流式）</span>
              </label>
            </div>
            <div className="settings-aggregator">
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
                <label htmlFor={`${fid}-agg-system`}>system</label>
                <textarea
                  id={`${fid}-agg-system`}
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
                <label htmlFor={`${fid}-agg-user`}>
                  user 模板（{"{{candidate}}"}、{"{{reviews}}"}）
                </label>
                <textarea
                  id={`${fid}-agg-user`}
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
        </div>
      </div>
      {fetchPicker && (
        <ModelFetchPickerModal
          key={fetchPicker.key}
          remoteIds={fetchPicker.remoteIds}
          initialCheckedIds={(
            settings.apiPresets.find((x) => x.id === fetchPicker.presetId)
              ?.fetchedModelIds ?? []
          ).filter((id) => fetchPicker.remoteIds.includes(id))}
          onConfirm={confirmFetchPicker}
          onCancel={() => setFetchPicker(null)}
        />
      )}
      {deleteConfirm && (
        <ConfirmModal
          title="确认删除"
          message={
            deleteConfirm.kind === "customEval"
              ? `确定要删除自定义题目「${deleteConfirm.label}」吗？删除后无法恢复。`
              : deleteConfirm.kind === "apiPreset"
                ? `确定要删除 API 预设「${deleteConfirm.label}」吗？使用该预设的参赛模型、Judge 与汇总将自动改绑到列表中剩余的第一个预设。`
                : `确定要删除评委「${deleteConfirm.label}」吗？删除后无法恢复。`
          }
          onConfirm={confirmPendingDelete}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
