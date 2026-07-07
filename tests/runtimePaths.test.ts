import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimeRootDir, resolveStaticDir } from "../src/server/runtimePaths.js";

describe("runtime path resolution", () => {
  it("resolves the repo root from the source server directory", () => {
    const sourceServerDir = resolve(process.cwd(), "src/server");
    expect(resolveRuntimeRootDir(sourceServerDir)).toBe(process.cwd());
  });

  it("resolves the repo root from the built server directory", () => {
    const builtServerDir = resolve(process.cwd(), "dist/server/server");
    expect(resolveRuntimeRootDir(builtServerDir)).toBe(process.cwd());
  });

  it("places static assets below the repo root", () => {
    expect(resolveStaticDir("/repo")).toBe(resolve("/repo", "dist/client"));
  });
});
