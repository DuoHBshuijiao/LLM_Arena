import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/** 合并本次上游列表中的勾选结果与历史「已拉取」中不在本次响应里的 id */
export function applyFetchedSelection(
  prevFetched: string[],
  remoteIds: string[],
  selectedFromRemote: string[],
): string[] {
  const remote = new Set(remoteIds);
  const keptOutsideRemote = prevFetched.filter((id) => !remote.has(id));
  return [...new Set([...keptOutsideRemote, ...selectedFromRemote])].sort(
    (a, b) => a.localeCompare(b),
  );
}

interface Props {
  remoteIds: string[];
  /** 打开弹层时应对 remoteIds 中哪些 id 预勾选（通常为历史 fetched 与 remote 的交集） */
  initialCheckedIds: string[];
  onConfirm: (selectedFromRemote: string[]) => void;
  onCancel: () => void;
}

export function ModelFetchPickerModal({
  remoteIds,
  initialCheckedIds,
  onConfirm,
  onCancel,
}: Props) {
  const titleId = useId().replace(/:/g, "");
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => {
    const s = new Set<string>();
    const remote = new Set(remoteIds);
    for (const id of initialCheckedIds) {
      if (remote.has(id)) s.add(id);
    }
    return s;
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return remoteIds;
    return remoteIds.filter((id) => id.toLowerCase().includes(q));
  }, [remoteIds, query]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const toggle = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllFiltered = useCallback(() => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const id of filtered) next.add(id);
      return next;
    });
  }, [filtered]);

  const handleConfirm = () => {
    onConfirm([...checked].sort((a, b) => a.localeCompare(b)));
  };

  const overlay = (
    <div
      className="model-fetch-modal"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="model-fetch-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="model-fetch-modal__head">
          <h2 id={titleId} className="model-fetch-modal__title">
            选择要加入列表的模型
          </h2>
          <p className="model-fetch-modal__lede muted small">
            上游返回 {remoteIds.length} 个模型 ID。请搜索、勾选后点确认；仅选中的会写入该预设的「已拉取」列表。
          </p>
        </header>
        <div className="model-fetch-modal__toolbar">
          <input
            ref={searchRef}
            type="search"
            className="model-fetch-modal__search"
            placeholder="按子串筛选模型 ID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索模型 ID"
          />
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={selectAllFiltered}
            disabled={filtered.length === 0}
          >
            全选当前筛选结果
          </button>
        </div>
        <div
          className="model-fetch-modal__list"
          role="group"
          aria-label="模型列表"
        >
          {filtered.length === 0 ? (
            <p className="model-fetch-modal__empty muted small">
              {remoteIds.length === 0
                ? "无可用模型。"
                : "无匹配项，请调整搜索词。"}
            </p>
          ) : (
            <ul className="model-fetch-modal__ul">
              {filtered.map((id) => (
                <li key={id} className="model-fetch-modal__li">
                  <label className="model-fetch-modal__row">
                    <input
                      type="checkbox"
                      checked={checked.has(id)}
                      onChange={() => toggle(id)}
                    />
                    <code className="model-fetch-modal__code">{id}</code>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="model-fetch-modal__count muted small">
          已选 {checked.size} 项（上游共 {remoteIds.length} 项）
        </p>
        <footer className="model-fetch-modal__actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={handleConfirm}>
            确认加入列表
          </button>
        </footer>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
