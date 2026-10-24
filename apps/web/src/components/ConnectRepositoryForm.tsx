import { useState, type FormEvent } from "react";

export const GITHUB_PAT_DOCS_URL =
  "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens";

interface ConnectRepositoryFormProps {
  disabled: boolean;
  error?: string;
  onConnect: (url: string, token?: string) => void;
}

export default function ConnectRepositoryForm({
  disabled,
  error,
  onConnect,
}: ConnectRepositoryFormProps) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUrl = url.trim();
    if (trimmedUrl === "") return;
    const trimmedToken = token.trim();
    onConnect(trimmedUrl, trimmedToken === "" ? undefined : trimmedToken);
  }

  return (
    <form className="connect-form" onSubmit={handleSubmit} autoComplete="off">
      <input
        type="url"
        className="connect-form__input"
        placeholder="https://github.com/owner/repo"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        disabled={disabled}
        aria-label="GitHub repository URL"
        required
      />
      <input
        type="password"
        className="connect-form__input"
        placeholder="GitHub token (private repos only)"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        disabled={disabled}
        aria-label="GitHub personal access token"
        aria-describedby={error ? "connect-form-error private-token-notice" : "private-token-notice"}
        aria-invalid={Boolean(error)}
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit" className="connect-form__button" disabled={disabled || url.trim() === ""}>
        {disabled ? "Connecting…" : "Connect Repository"}
      </button>
      {error ? (
        <p id="connect-form-error" className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <aside id="private-token-notice" className="connect-form__notice" aria-labelledby="private-token-notice-title">
        <h2 id="private-token-notice-title" className="connect-form__notice-title">
          Private repository token
        </h2>
        <p>
          Use a <strong>GitHub Fine-grained Personal Access Token (PAT)</strong> whenever GitHub
          supports it. Restrict the token to <strong>only the repository</strong> you want RepoPilot
          to access.
        </p>
        <p>
          RepoPilot needs read-only source access to inspect and explain code. Grant{" "}
          <strong>Repository permissions → Contents: Read-only</strong>. Do not grant Contents: Read
          and write, or Administration, Issues, Pull requests, Workflows, or other permissions.
          GitHub automatically includes Metadata: Read-only with Contents; that is enough to confirm
          the repository and download its archive.
        </p>
        <p>
          This token is sensitive. Enter it only in the token field above. Never paste it into chat,
          commit it to source control, or share it publicly.
        </p>
        <p>
          <a
            className="connect-form__notice-link"
            href={GITHUB_PAT_DOCS_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            GitHub documentation: create a fine-grained personal access token
          </a>
        </p>
      </aside>
      <p className="connect-form__hint">
        Public repositories work without a token. Private repositories require a token you are
        authorized to use — RepoPilot will not bypass GitHub permissions. The token is sent only to
        this app&apos;s backend for this request, is not stored, and is never sent to Gemini.
      </p>
    </form>
  );
}
