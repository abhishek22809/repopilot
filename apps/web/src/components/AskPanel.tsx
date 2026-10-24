import { useState, type FormEvent } from "react";
import { askRepository } from "../services/apiClient";
import type { AskResponse } from "../types/api";

interface AskPanelProps {
  sessionId: string;
  isPrivate?: boolean;
  onOpenSource: (path: string) => void;
}

type AskState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "answered"; data: AskResponse }
  | { status: "error"; message: string };

export default function AskPanel({ sessionId, isPrivate = false, onOpenSource }: AskPanelProps) {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<AskState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed === "") return;
    setState({ status: "loading" });
    try {
      const data = await askRepository(sessionId, trimmed);
      setState({ status: "answered", data });
    } catch (error: unknown) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Request failed." });
    }
  }

  return (
    <section className="ask">
      <div className="ask__header">
        <h3 className="ask__title">Ask RepoPilot</h3>
        <span className="ask__hint">Answers are grounded in this repository's code.</span>
      </div>
      {isPrivate && (
        <p className="ask__privacy" role="note">
          This repository is private. Asking a question sends retrieved source excerpts to the
          configured AI provider. Confirm your organization's AI and data-sharing policy before
          using Ask with company code. RepoPilot cannot enforce that policy.
        </p>
      )}

      <form className="ask__form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="ask__input"
          placeholder="e.g. How does the app start?"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          aria-label="Ask a question about the repository"
          maxLength={2000}
        />
        <button type="submit" className="ask__button" disabled={state.status === "loading" || question.trim() === ""}>
          {state.status === "loading" ? "Thinking…" : "Ask"}
        </button>
      </form>

      {state.status === "error" && (
        <p className="ask__error" role="alert">
          {state.message}
        </p>
      )}

      {state.status === "answered" && (
        <div className="ask__answer">
          {!state.data.grounded && (
            <p className="ask__badge">No supporting files were cited — treat this answer with caution.</p>
          )}
          <p className="ask__text">{state.data.answer}</p>
          {state.data.sources.length > 0 && (
            <div className="ask__sources">
              <span className="ask__sources-label">Sources</span>
              <ul>
                {state.data.sources.map((source) => (
                  <li key={source.path}>
                    <button type="button" onClick={() => onOpenSource(source.path)}>
                      {source.path}
                      {source.lines ? `:${source.lines}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
