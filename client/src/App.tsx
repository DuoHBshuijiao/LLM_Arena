import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChartsTabPane,
  prefetchChartsPanel,
  prefetchRunPanel,
  RunTabPane,
  SettingsTabPane,
} from "./components/AppTabContent";
import { useAppKeyboardShortcuts } from "./useAppKeyboardShortcuts";

type Tab = "settings" | "run" | "charts";

export default function App() {
  const [tab, setTab] = useState<Tab>("settings");
  const shortcutsDetailsRef = useRef<HTMLDetailsElement>(null);

  const toggleShortcutsHelp = useCallback(() => {
    const el = shortcutsDetailsRef.current;
    if (!el) return;
    el.open = !el.open;
    if (el.open) {
      const s = el.querySelector("summary");
      (s as HTMLElement | null)?.focus?.();
    }
  }, []);

  useAppKeyboardShortcuts(setTab, toggleShortcutsHelp);
  const [proxyHealth, setProxyHealth] = useState<
    "checking" | "ok" | "offline"
  >("checking");

  const checkProxyHealth = useCallback(() => {
    setProxyHealth("checking");
    const ac = new AbortController();
    const t = window.setTimeout(() => ac.abort(), 8000);
    fetch("/api/health", { signal: ac.signal })
      .then((r) => {
        clearTimeout(t);
        setProxyHealth(r.ok ? "ok" : "offline");
      })
      .catch(() => {
        clearTimeout(t);
        setProxyHealth("offline");
      });
  }, []);

  useEffect(() => {
    checkProxyHealth();
  }, [checkProxyHealth]);

  return (
    <div className="app">
      <a href="#main-content" className="skip-link">
        跳到主内容
      </a>
      <header className="app-header">
        <h1 className="app-title">
          <span className="app-title__mark">LLM</span>{" "}
          <span className="app-title__rest">Arena</span>
        </h1>
        <span className="badge badge--health">
          本地代理：{" "}
          {proxyHealth === "checking" && "检测中…"}
          {proxyHealth === "ok" && "已连接"}
          {proxyHealth === "offline" && (
            <>
              <span className="badge__health-msg">未连接</span>
              <button
                type="button"
                className="badge__retry"
                onClick={checkProxyHealth}
              >
                重试
              </button>
            </>
          )}
        </span>
        <nav className="app-nav" aria-label="主导航">
          {(
            [
              ["settings", "设置", "Alt+Shift+1"],
              ["run", "运行与结果", "Alt+Shift+2"],
              ["charts", "人工分与图表", "Alt+Shift+3"],
            ] as const
          ).map(([id, label, shortcutHint]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "active" : ""}
              aria-current={tab === id ? "page" : undefined}
              title={`${label}（快捷键 ${shortcutHint}）`}
              onClick={() => setTab(id)}
              onMouseEnter={() => {
                if (id === "run") prefetchRunPanel();
                if (id === "charts") prefetchChartsPanel();
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        <details ref={shortcutsDetailsRef} className="app-shortcuts">
          <summary className="app-shortcuts__summary">
            键盘快捷键
          </summary>
          <div className="app-shortcuts__body">
            <p className="muted small app-shortcuts__note">
              在输入框、文本域内输入时不会触发切换，避免打断编辑。
            </p>
            <ul className="app-shortcuts__list">
              <li>
                <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>1</kbd>：设置
              </li>
              <li>
                <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>2</kbd>：运行与结果
              </li>
              <li>
                <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>3</kbd>：人工分与图表
              </li>
              <li>
                <kbd>F1</kbd> 或 <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>/</kbd>
                ：展开/收起本说明
              </li>
            </ul>
          </div>
        </details>
      </header>

      <main id="main-content" className="app-tab-panel" key={tab}>
        {tab === "settings" && <SettingsTabPane />}
        {tab === "run" && <RunTabPane />}
        {tab === "charts" && <ChartsTabPane />}
      </main>
    </div>
  );
}
