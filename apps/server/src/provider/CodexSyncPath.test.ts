import { describe, expect, it } from "vite-plus/test";

import {
  canonicalizeProviderPath,
  providerPathsEqual,
  providerProjectName,
} from "./CodexSyncPath.ts";

describe("canonicalizeProviderPath", () => {
  it("normalizes POSIX paths without changing case", () => {
    expect(canonicalizeProviderPath("/Users/dev/../dev/t3code/")).toEqual({
      path: "/Users/dev/t3code",
      key: "/Users/dev/t3code",
      platform: "posix",
      isRoot: false,
    });
  });

  it("normalizes Windows drive paths independently of the server host", () => {
    expect(canonicalizeProviderPath("d:\\Work\\t3code\\")).toEqual({
      path: "D:/Work/t3code",
      key: "d:/work/t3code",
      platform: "windows",
      isRoot: false,
    });
  });

  it("normalizes UNC paths and compares Windows paths case-insensitively", () => {
    expect(canonicalizeProviderPath("\\\\Server\\Share\\repo\\")).toEqual({
      path: "//Server/Share/repo",
      key: "//server/share/repo",
      platform: "windows",
      isRoot: false,
    });
    expect(providerPathsEqual("C:\\Users\\Dev\\Repo", "c:/users/dev/repo/")).toBe(true);
  });

  it("rejects relative paths and marks filesystem roots", () => {
    expect(canonicalizeProviderPath("relative/project")).toBeNull();
    expect(canonicalizeProviderPath("/")?.isRoot).toBe(true);
    expect(canonicalizeProviderPath("C:\\")?.isRoot).toBe(true);
    expect(canonicalizeProviderPath("\\\\server\\share")?.isRoot).toBe(true);
  });

  it("derives the project name from canonical paths", () => {
    const posix = canonicalizeProviderPath("/work/t3code");
    const windows = canonicalizeProviderPath("D:\\work\\t3code");
    expect(posix && providerProjectName(posix)).toBe("t3code");
    expect(windows && providerProjectName(windows)).toBe("t3code");
  });
});
