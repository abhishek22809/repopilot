import { describe, expect, it } from "vitest";
import { parseGitHubRepoUrl } from "../src/utils/githubUrl.js";

describe("parseGitHubRepoUrl - accepts valid public GitHub URLs", () => {
  const valid: Array<[string, { owner: string; repo: string }]> = [
    ["https://github.com/facebook/react", { owner: "facebook", repo: "react" }],
    ["https://github.com/facebook/react.git", { owner: "facebook", repo: "react" }],
    ["https://github.com/facebook/react/", { owner: "facebook", repo: "react" }],
    ["https://www.github.com/vuejs/core", { owner: "vuejs", repo: "core" }],
    ["  https://github.com/owner/repo  ", { owner: "owner", repo: "repo" }],
    ["https://github.com/some-org/my_repo.name", { owner: "some-org", repo: "my_repo.name" }],
    ["https://github.com/facebook/react/tree/main", { owner: "facebook", repo: "react" }],
  ];

  it.each(valid)("%s", (input, expected) => {
    expect(parseGitHubRepoUrl(input)).toEqual(expected);
  });
});

describe("parseGitHubRepoUrl - rejects invalid or unsafe URLs", () => {
  const invalid = [
    "",
    "not a url",
    "ftp://github.com/owner/repo",
    "http://github.com/owner/repo", // non-HTTPS
    "git@github.com:owner/repo.git", // SSH
    "https://gitlab.com/owner/repo", // other host
    "https://github.com.evil.com/owner/repo", // look-alike host
    "https://evil.com/github.com/owner/repo",
    "https://github.com/owner", // missing repo
    "https://github.com/", // missing owner and repo
    "https://localhost/owner/repo",
    "https://127.0.0.1/owner/repo",
    "https://user:pass@github.com/owner/repo", // credentials
    "https://github.com:8080/owner/repo", // explicit port
    "file:///etc/passwd",
  ];

  it.each(invalid)("%s", (input) => {
    expect(parseGitHubRepoUrl(input)).toBeNull();
  });
});
