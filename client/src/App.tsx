import { useCallback, useEffect, useState } from "react";
import {
  ChartsTabPane,
  prefetchChartsPanel,
  prefetchRunPanel,
  RunTabPane,
  SettingsTabPane,
} from "./components/AppTabContent";

type Tab = "settings" | "run" | "charts";

export default function App() {
  const [tab, setTab] = useState<Tab>("settings");
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
              ["settings", "设置"],
              ["run", "运行与结果"],
              ["charts", "人工分与图表"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "active" : ""}
              aria-current={tab === id ? "page" : undefined}
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
      </header>

      <main id="main-content" className="app-tab-panel" key={tab}>
        {tab === "settings" && <SettingsTabPane />}
        {tab === "run" && <RunTabPane />}
        {tab === "charts" && <ChartsTabPane />}
      </main>
    </div>
  );
}
