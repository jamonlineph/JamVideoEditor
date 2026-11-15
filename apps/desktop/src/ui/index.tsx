import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { live } from "./live.js";

/** Shows a render error instead of a blank window (and keeps the engine connection alive). */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h3>Something went wrong in this view</h3>
        <pre>{String(this.state.error.stack ?? this.state.error.message)}</pre>
        <button className="primary" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}

// Platform class: the title bar leaves room for macOS traffic lights or Windows window buttons.
document.body.classList.add(`platform-${process.platform}`);

// Entry point: mount the UI, then connect to the engine's /live channel (state arrives in `hello`).
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
void live.connect().catch((e: Error) => live.toast("error", e.message));
(window as unknown as { openedits: unknown }).openedits = { live };
