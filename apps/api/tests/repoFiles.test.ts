import { describe, expect, it } from "vitest";
import { shouldExtractEntry, stripTopLevelDir } from "../src/utils/repoFiles.js";

describe("shouldExtractEntry", () => {
  it("keeps normal source files and directories", () => {
    expect(shouldExtractEntry("README.md", "File")).toBe(true);
    expect(shouldExtractEntry("src/index.ts", "File")).toBe(true);
    expect(shouldExtractEntry("src", "Directory")).toBe(true);
    expect(shouldExtractEntry(".env.example", "File")).toBe(true);
  });

  it("rejects symlinks and hardlinks", () => {
    expect(shouldExtractEntry("src/link", "SymbolicLink")).toBe(false);
    expect(shouldExtractEntry("src/link", "Link")).toBe(false);
    expect(shouldExtractEntry("src/dev", "Other")).toBe(false);
  });

  it("excludes VCS, dependency, and build directories", () => {
    expect(shouldExtractEntry(".git/config", "File")).toBe(false);
    expect(shouldExtractEntry("node_modules/left-pad/index.js", "File")).toBe(false);
    expect(shouldExtractEntry("dist/bundle.js", "File")).toBe(false);
    expect(shouldExtractEntry("build/output.o", "File")).toBe(false);
    expect(shouldExtractEntry("packages/app/node_modules/x.js", "File")).toBe(false);
  });

  it("excludes secret files", () => {
    expect(shouldExtractEntry(".env", "File")).toBe(false);
    expect(shouldExtractEntry(".env.local", "File")).toBe(false);
    expect(shouldExtractEntry("config/server.pem", "File")).toBe(false);
    expect(shouldExtractEntry(".npmrc", "File")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(shouldExtractEntry("../escape.txt", "File")).toBe(false);
    expect(shouldExtractEntry("a/../../b", "File")).toBe(false);
    expect(shouldExtractEntry("", "File")).toBe(false);
  });
});

describe("stripTopLevelDir", () => {
  it("removes the GitHub tarball wrapper folder", () => {
    expect(stripTopLevelDir("owner-repo-abc123/src/index.ts")).toBe("src/index.ts");
    expect(stripTopLevelDir("owner-repo-abc123/README.md")).toBe("README.md");
    expect(stripTopLevelDir("owner-repo-abc123")).toBe("");
  });
});
