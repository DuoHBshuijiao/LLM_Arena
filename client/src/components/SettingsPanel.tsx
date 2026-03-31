import type { GlobalSettings, JudgeConfig, ModelEntry } from "../types";
import { newId } from "../store";

interface Props {
  settings: GlobalSettings;
  onChange: (s: GlobalSettings) => void;
}

export function SettingsPanel({ settings, onChange }: Props) {
  const patch = (p: Partial<GlobalSettings>) =>
    onChange({ ...settings, ...p });

  const setModels = (models: ModelEntry[]) => patch({ models });
  const setJudges = (judges: JudgeConfig[]) => patch({ judges });

  return (
    <div className="panel">
      <h2>设置</h2>
      <p className="muted">
        配置与评测结果保存在本机浏览器 localStorage；清除站点数据会丢失。
      </p>

      <div className="field">
        <label>Base URL（OpenAI 兼容）</label>
        <input
          value={settings.baseUrl}
          onChange={(e) => patch({ baseUrl: e.target.value })}
          placeholder="https://api.openai.com"
        />
      </div>
      <div className="field">
        <label>API Key</label>
        <input
          type="password"
          autoComplete="off"
          value={settings.apiKey}
          onChange={(e) => patch({ apiKey: e.target.value })}
          placeholder="sk-..."
        />
      </div>

      <div className="row">
        <div className="field">
          <label>temperature</label>
          <input
            type="number"
            step={0.1}
            min={0}
            max={2}
            value={settings.temperature}
            onChange={(e) =>
              patch({ temperature: Number(e.target.value) })
            }
          />
        </div>
        <div className="field">
          <label>max_tokens</label>
          <input
            type="number"
            min={1}
            value={settings.maxTokens}
            onChange={(e) =>
              patch({ maxTokens: Number(e.target.value) })
            }
          />
        </div>
        <div className="field">
          <label>top_p</label>
          <input
            type="number"
            step={0.05}
            min={0}
            max={1}
            value={settings.topP}
            onChange={(e) => patch({ topP: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>并发上限</label>
          <input
            type="number"
            min={1}
            max={32}
            value={settings.concurrency}
            onChange={(e) =>
              patch({ concurrency: Number(e.target.value) })
            }
          />
        </div>
      </div>

      <h3 className="muted" style={{ fontSize: "0.95rem", marginTop: "1rem" }}>
        模型列表
      </h3>
      {settings.models.map((m, idx) => (
        <div key={m.id} className="row" style={{ marginBottom: "0.5rem" }}>
          <div className="field">
            <label>model id</label>
            <input
              value={m.modelId}
              onChange={(e) => {
                const next = [...settings.models];
                next[idx] = { ...m, modelId: e.target.value };
                setModels(next);
              }}
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
            className="btn-ghost"
            onClick={() =>
              setModels(settings.models.filter((x) => x.id !== m.id))
            }
          >
            删除
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-ghost"
        onClick={() =>
          setModels([
            ...settings.models,
            { id: newId(), modelId: "gpt-4o-mini", sampleCount: 1 },
          ])
        }
      >
        + 添加模型
      </button>

      <h3 className="muted" style={{ fontSize: "0.95rem", marginTop: "1rem" }}>
        Judge 列表
      </h3>
      {settings.judges.map((j, idx) => (
        <div
          key={j.id}
          style={{
            border: "1px solid #2a3140",
            borderRadius: 8,
            padding: "0.65rem",
            marginBottom: "0.65rem",
          }}
        >
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
            <div className="field">
              <label>Judge 所用 model</label>
              <input
                value={j.model}
                onChange={(e) => {
                  const next = [...settings.judges];
                  next[idx] = { ...j, model: e.target.value };
                  setJudges(next);
                }}
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
            <button
              type="button"
              className="btn-ghost"
              onClick={() =>
                setJudges(settings.judges.filter((x) => x.id !== j.id))
              }
            >
              删除
            </button>
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
            <label>user 模板（{"{{candidate}}"} 为候选回复）</label>
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
              model: "gpt-4o-mini",
              systemPrompt: "你是评测助手，只输出 JSON。",
              userPromptTemplate:
                '输出 JSON：{"overall":0-10,"dimensions":{},"brief_reason":""}\n\n候选：\n{{candidate}}',
              reviewCount: 1,
            },
          ])
        }
      >
        + 添加 Judge
      </button>

      <h3 className="muted" style={{ fontSize: "0.95rem", marginTop: "1rem" }}>
        汇总模型
      </h3>
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
      <div className="row">
        <div className="field">
          <label>汇总 model</label>
          <input
            value={settings.aggregator.model}
            onChange={(e) =>
              patch({
                aggregator: { ...settings.aggregator, model: e.target.value },
              })
            }
          />
        </div>
      </div>
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
  );
}
