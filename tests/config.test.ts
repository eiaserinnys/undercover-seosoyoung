import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("configuration", () => {
  it("ignores a generic inherited PORT and uses the service-specific default", () => {
    process.env.PORT = "4105";
    delete process.env.UNDERCOVER_PORT;

    expect(loadConfig(process.cwd()).port).toBe(4318);
  });

  it("uses UNDERCOVER_PORT when the service explicitly sets it", () => {
    process.env.PORT = "4105";
    process.env.UNDERCOVER_PORT = "4500";

    expect(loadConfig(process.cwd()).port).toBe(4500);
  });
});
