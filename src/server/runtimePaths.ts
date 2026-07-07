import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function resolveRuntimeRootDir(serverDir: string, fallbackDir = process.cwd()): string {
  const sourceRoot = resolve(serverDir, "../..");
  if (existsSync(resolve(sourceRoot, "package.json"))) return sourceRoot;

  const buildRoot = resolve(serverDir, "../../..");
  if (existsSync(resolve(buildRoot, "package.json"))) return buildRoot;

  return fallbackDir;
}

export function resolveStaticDir(rootDir: string): string {
  return resolve(rootDir, "dist/client");
}
