import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type CustomSelectOption = { value: string; label: string };

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  disabled?: boolean;
  /** value 为空时展示的占位项（如「请选择…」） */
  placeholderOption?: CustomSelectOption;
  className?: string;
}

export function CustomSelect({
  id,
  value,
  onChange,
  options,
  disabled = false,
  placeholderOption,
  className = "",
}: Props) {
  const listboxId = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const rows: CustomSelectOption[] = placeholderOption
    ? [placeholderOption, ...options]
    : options;

  const selectedLabel = (() => {
    const hit = rows.find((o) => o.value === value);
    return hit?.label ?? rows[0]?.label ?? "";
  })();

  const selectedIndex = Math.max(
    0,
    rows.findIndex((o) => o.value === value),
  );

  useLayoutEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const commit = useCallback(
    (v: string) => {
      onChange(v);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      if (!open) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(rows.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) commit(row.value);
    }
  };

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  return (
    <div
      ref={wrapRef}
      className={`custom-select ${open ? "custom-select--open" : ""} ${className}`.trim()}
      onKeyDown={onKeyDown}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="custom-select__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open ? `${listboxId}-opt-${activeIndex}` : undefined
        }
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open || e.key !== " ") return;
          e.preventDefault();
          const row = rows[activeIndex];
          if (row) commit(row.value);
        }}
      >
        <span className="custom-select__value">{selectedLabel}</span>
        <span className="custom-select__chevron" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path
              d="M3 4.5L6 7.5L9 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {open && (
        <div
          ref={listRef}
          id={listboxId}
          className="custom-select__list"
          role="listbox"
          tabIndex={-1}
        >
          {rows.map((row, index) => (
            <div
              key={`${row.value}-${index}`}
              id={`${listboxId}-opt-${index}`}
              role="option"
              data-index={index}
              aria-selected={row.value === value}
              className={
                index === activeIndex
                  ? "custom-select__option custom-select__option--active"
                  : "custom-select__option"
              }
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => commit(row.value)}
            >
              {row.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
