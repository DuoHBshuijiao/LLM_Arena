import { useEffect, useRef } from "react";

export type AppTabId = "settings" | "run" | "charts";

/**
 * 全局键盘快捷：在可编辑区域（输入框、下拉等）内不拦截，避免与正常输入冲突。
 * 选用 Alt+Shift+数字：避免与浏览器「Ctrl+数字切标签页」及常见编辑器快捷键冲突。
 */
function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return false;
}

export function useAppKeyboardShortcuts(
  setTab: (t: AppTabId) => void,
  onToggleShortcutsHelp?: () => void,
): void {
  const helpRef = useRef(onToggleShortcutsHelp);
  helpRef.current = onToggleShortcutsHelp;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.repeat) return;
      if (e.ctrlKey || e.metaKey) {
        // 不占用 Ctrl/Cmd 组合，交给浏览器与系统菜单
        return;
      }
      if (isEditableTarget(e.target)) return;

      if (e.altKey && e.shiftKey) {
        if (e.key === "1" || e.key === "Digit1") {
          e.preventDefault();
          setTab("settings");
          return;
        }
        if (e.key === "2" || e.key === "Digit2") {
          e.preventDefault();
          setTab("run");
          return;
        }
        if (e.key === "3" || e.key === "Digit3") {
          e.preventDefault();
          setTab("charts");
          return;
        }
      }

      // F1 或 Alt+Shift+/：打开快捷键说明（F1 不依赖键盘布局）
      if (e.key === "F1") {
        e.preventDefault();
        helpRef.current?.();
        return;
      }
      if (e.altKey && e.shiftKey && (e.key === "/" || e.key === "?" || e.code === "Slash")) {
        e.preventDefault();
        helpRef.current?.();
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setTab]);
}
