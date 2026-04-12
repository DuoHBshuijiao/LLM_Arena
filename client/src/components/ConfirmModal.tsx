import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 简单焦点管理：打开时锁住 body 滚动、聚焦主按钮、Tab 在面板内循环；关闭时还原焦点 */
export function ConfirmModal({
  title,
  message,
  confirmLabel = "删除",
  cancelLabel = "取消",
  onConfirm,
  onCancel,
}: Props) {
  const titleId = useId().replace(/:/g, "");
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    prevFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      /** 优先聚焦「取消」，降低误确认（尤其清空类操作） */
      const first = panel?.querySelector<HTMLElement>(
        ".confirm-modal__actions button",
      );
      (first ?? panel)?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      const p = prevFocus.current;
      if (p?.isConnected) p.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const list = Array.from(nodes).filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
      );
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener("keydown", onKeyDown);
    return () => panel.removeEventListener("keydown", onKeyDown);
  }, []);

  const overlay = (
    <div
      className="confirm-modal"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className="confirm-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="confirm-modal__head">
          <h2 id={titleId} className="confirm-modal__title">
            {title}
          </h2>
        </header>
        <p className="confirm-modal__message muted small">{message}</p>
        <footer className="confirm-modal__actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="confirm-modal__confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
