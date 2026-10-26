import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import config from "./next.config";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("reproducible build ID", () => {
  const sha = "a".repeat(40);
  beforeEach(() => {
    vi.stubEnv("MOSS_WEB_BUILD_ID", undefined);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", undefined);
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("no Git checkout"); });
  });
  it("builds from Vercel source metadata without invoking Git", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", sha);
    expect(await config.generateBuildId!()).toBe(sha);
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it("preserves an explicit release build ID", async () => {
    vi.stubEnv("MOSS_WEB_BUILD_ID", "reviewed-release");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", sha);
    expect(await config.generateBuildId!()).toBe("reviewed-release");
  });
  it("uses Git when Vercel metadata is empty", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.mocked(execFileSync).mockReturnValue(sha + "\n");
    expect(await config.generateBuildId!()).toBe(sha);
  });
  it.each(["abcdef", "../unsafe", "z".repeat(40)])("rejects malformed commit metadata (%s)", async (value) => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", value);
    await expect(config.generateBuildId!()).rejects.toThrow("full lowercase Git SHA");
  });
  it("fails closed without a reproducible source", async () => {
    await expect(config.generateBuildId!()).rejects.toThrow("build ID must be reproducible");
  });
});

it("isolates development output from production builds", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.resetModules();
  expect((await import("./next.config")).default.distDir).toBe(".next-dev");
  vi.stubEnv("NODE_ENV", "production");
  vi.resetModules();
  expect((await import("./next.config")).default.distDir).toBe(".next");
});

describe("script Content Security Policy", () => {
  it.each(["development", "production", "test"])(
    "allows the Next eval runtime only in development (%s)",
    async (mode) => {
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("COORDINATOR_BASE_URL", "http://127.0.0.1:58787");
      vi.stubEnv("ARTIFACT_ORIGINS", "");
      const routes = await config.headers!();
      const policy = routes[0]!.headers.find(
        (header) => header.key === "Content-Security-Policy",
      )!.value;
      const script = policy.split("; ").find((part) => part.startsWith("script-src "))!;
      expect(script.split(" ").includes("'unsafe-eval'")).toBe(mode === "development");
      expect(script).toContain("'wasm-unsafe-eval'");
      expect(policy).toContain("connect-src 'self' http://127.0.0.1:58787");
    },
  );
});

it("allows the wallet iframe only on the dedicated collectible document", async () => {
  const routes = await config.headers!();
  const common = routes.find(route => route.source === "/:path*")!;
  const collect = routes.find(route => route.source === "/collect")!;
  const csp = (route: typeof common) => route.headers.find(h => h.key === "Content-Security-Policy")!.value;
  expect(common.headers.find(h => h.key === "Referrer-Policy")?.value).toBe("no-referrer");
  expect(collect.headers.find(h => h.key === "Referrer-Policy")?.value).toBe("strict-origin");
  expect(csp(common)).toContain("frame-src 'none'");
  expect(csp(common)).not.toContain("account.megaeth.com");
  expect(csp(collect)).toContain("frame-src https://account.megaeth.com");
  expect(csp(collect)).not.toContain("connect-src https:");
});

it("seals webpack entries in name order, whatever order Next added them", () => {
  const webpackConfig = { plugins: [] as { apply(compiler: unknown): void }[], resolve: {}, module: {} };
  config.webpack!(webpackConfig, { isServer: false } as never);
  let onCompilation: ((compilation: unknown) => void) | undefined;
  let onSeal: (() => void) | undefined;
  for (const plugin of webpackConfig.plugins) {
    plugin.apply({ hooks: { compilation: { tap: (_: string, fn: typeof onCompilation) => { onCompilation = fn; } } } });
  }
  const entries = new Map(["main", "main-app", "pages/_app", "app/page", "app/layout", "app/how-it-works/page"].map(name => [name, { name }]));
  onCompilation!({ entries, hooks: { seal: { tap: (_: string, fn: () => void) => { onSeal = fn; } } } });
  onSeal!();
  expect([...entries.keys()]).toEqual(["app/how-it-works/page", "app/layout", "app/page", "main", "main-app", "pages/_app"]);
  expect(entries.get("app/page")).toEqual({ name: "app/page" });
});
