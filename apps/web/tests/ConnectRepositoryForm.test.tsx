import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ConnectRepositoryForm, {
  GITHUB_PAT_DOCS_URL,
} from "../src/components/ConnectRepositoryForm";

function renderForm(disabled = false, error?: string): string {
  return renderToStaticMarkup(
    createElement(ConnectRepositoryForm, { disabled, error, onConnect: () => undefined }),
  );
}

describe("ConnectRepositoryForm private-token notice", () => {
  it("shows a security notice next to the token field", () => {
    const html = renderForm();

    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="GitHub personal access token"');
    expect(html).toContain('aria-describedby="private-token-notice"');
    expect(html).toContain("Private repository token");
    expect(html).toMatch(/Fine-grained Personal Access Token/);
    expect(html).toMatch(/only the repository/i);
    expect(html).toMatch(/Contents: Read-only/);
    expect(html).toMatch(/Do not grant Contents: Read and write/);
    expect(html).toMatch(/Administration, Issues, Pull requests, Workflows/);
    expect(html).toMatch(/read-only source access/i);
    expect(html).toMatch(/Never paste it into chat/);
    expect(html).toMatch(/commit it to source control/);
    expect(html).toMatch(/share it publicly/);
    expect(html).toMatch(/token field above/);
  });

  it("links to GitHub's official fine-grained token documentation", () => {
    const html = renderForm();
    expect(html).toContain(`href="${GITHUB_PAT_DOCS_URL}"`);
    expect(GITHUB_PAT_DOCS_URL).toBe(
      "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    );
    expect(html).toContain("rel=\"noreferrer noopener\"");
  });

  it("keeps public repository connection available without a token", () => {
    const html = renderForm();
    expect(html).toMatch(/Public repositories work without a token/);
    expect(html).toContain('placeholder="https://github.com/owner/repo"');
    expect(html).not.toMatch(/ghp_|github_pat_/);
  });

  it("renders a connect error above the token warning", () => {
    const message = "Repository not found. It may be private or the URL is incorrect.";
    const html = renderForm(false, message);
    const errorAt = html.indexOf(message);
    const warningAt = html.indexOf("Private repository token");
    expect(errorAt).toBeGreaterThan(-1);
    expect(warningAt).toBeGreaterThan(errorAt);
    expect(html).toContain('id="connect-form-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-describedby="connect-form-error private-token-notice"');
  });
});
