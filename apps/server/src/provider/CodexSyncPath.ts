// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

export type CanonicalProviderPath = {
  /** Stable display/storage form. Windows separators are always `/`. */
  readonly path: string;
  /** Comparison key. Windows and UNC paths are case-insensitive. */
  readonly key: string;
  readonly platform: "windows" | "posix";
  readonly isRoot: boolean;
};

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;

function stripTrailingSeparators(path: string, minimumLength: number): string {
  let end = path.length;
  while (end > minimumLength && path[end - 1] === "/") {
    end -= 1;
  }
  return path.slice(0, end);
}

function canonicalizeWindowsPath(input: string): CanonicalProviderPath | null {
  if (!WINDOWS_DRIVE_ABSOLUTE.test(input) && !WINDOWS_UNC_ABSOLUTE.test(input)) {
    return null;
  }

  const normalized = NodePath.win32.normalize(input).replaceAll("\\", "/");
  if (WINDOWS_DRIVE_ABSOLUTE.test(normalized)) {
    const drive = normalized.slice(0, 2).toUpperCase();
    const withCanonicalDrive = `${drive}${normalized.slice(2)}`;
    const path = stripTrailingSeparators(withCanonicalDrive, 3);
    const isRoot = path.length === 3 && path[2] === "/";
    return {
      path,
      key: path.toLowerCase(),
      platform: "windows",
      isRoot,
    };
  }

  const prefixed = normalized.startsWith("//") ? normalized : `//${normalized.replace(/^\/+/, "")}`;
  const parts = prefixed.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const minimumLength = `//${parts[0]}/${parts[1]}`.length;
  const path = stripTrailingSeparators(prefixed, minimumLength);
  return {
    path,
    key: path.toLowerCase(),
    platform: "windows",
    isRoot: parts.length === 2,
  };
}

/**
 * Canonicalize a provider-reported cwd without interpreting it using the
 * server host's platform. This is important when a remote/Windows Codex
 * app-server reports `D:\\repo` to a server process running elsewhere.
 */
export function canonicalizeProviderPath(input: string): CanonicalProviderPath | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const windows = canonicalizeWindowsPath(trimmed);
  if (windows) {
    return windows;
  }

  if (!NodePath.posix.isAbsolute(trimmed)) {
    return null;
  }
  const normalized = NodePath.posix.normalize(trimmed);
  const path = normalized === "/" ? normalized : stripTrailingSeparators(normalized, 1);
  return {
    path,
    key: path,
    platform: "posix",
    isRoot: path === "/",
  };
}

export function providerPathsEqual(left: string, right: string): boolean {
  const canonicalLeft = canonicalizeProviderPath(left);
  const canonicalRight = canonicalizeProviderPath(right);
  return canonicalLeft !== null && canonicalRight !== null && canonicalLeft.key === canonicalRight.key;
}

export function providerProjectName(path: CanonicalProviderPath): string {
  if (path.platform === "windows") {
    const withoutTrailingSlash = path.path.replace(/\/$/, "");
    return NodePath.win32.basename(withoutTrailingSlash.replaceAll("/", "\\"));
  }
  return NodePath.posix.basename(path.path);
}
