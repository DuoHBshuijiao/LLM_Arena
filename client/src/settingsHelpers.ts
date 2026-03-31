import type { ApiPreset, GlobalSettings } from "./types";

export function getPreset(
  settings: GlobalSettings,
  presetId: string,
): ApiPreset | undefined {
  return settings.apiPresets.find((p) => p.id === presetId);
}

/** 至少有一个预设填了 Key，且每条参赛模型 / Judge / 汇总均指向有效预设并已选 model */
export function settingsReadyForRun(settings: GlobalSettings): boolean {
  if (!settings.models.length) return false;
  for (const m of settings.models) {
    if (!m.modelId.trim()) return false;
    const p = getPreset(settings, m.presetId);
    if (!p || !p.apiKey.trim()) return false;
  }
  for (const j of settings.judges) {
    if (!j.model.trim()) return false;
    const p = getPreset(settings, j.presetId);
    if (!p || !p.apiKey.trim()) return false;
  }
  if (settings.aggregator.enabled) {
    if (!settings.aggregator.model.trim()) return false;
    const p = getPreset(settings, settings.aggregator.presetId);
    if (!p || !p.apiKey.trim()) return false;
  }
  return true;
}
