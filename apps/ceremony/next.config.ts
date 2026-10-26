import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep a running preview intact when a production build runs alongside it.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  outputFileTracingRoot: resolve(__dirname, "../.."),
  // Next otherwise names the build directory with a random ID, which is the
  // only thing that differs between two builds of the same commit. Deriving it
  // from the source commit makes the served bundle reproducible — so the
  // published webRelease digest can be checked by anyone rebuilding it — while
  // still giving each release distinct, safely cacheable asset paths.
  generateBuildId: async () => webBuildId(),
  // Integrity attributes bind the HTML to the exact chunk bytes, so the only
  // thing a contributor trusts on first load is the document itself.
  experimental: { sri: { algorithm: "sha256" } },
  async headers() {
    // Next serialises these headers into routes-manifest.json during `next
    // build` and `next start` replays them, so both variables below are
    // build-time inputs. Every other consumer of COORDINATOR_BASE_URL reads it
    // per request, which makes this easy to miss: a production image built
    // without it ships `connect-src 'self'`, the bootstrap route still works
    // because it is same-origin, and then every coordinator call is blocked
    // with nothing but a console violation.
    const coordinatorOrigin = coordinatorConnectSource(
      process.env.COORDINATOR_BASE_URL,
    );
    // NODE_ENV is "production" for every `next build`, including the local
    // development gate, so it cannot distinguish a deployment build. Warn
    // rather than fail, and let the deployment check enforce it.
    if (!coordinatorOrigin) {
      console.warn(
        "[ceremony] COORDINATOR_BASE_URL is unset; this build bakes `connect-src 'self'` and the deployed app will be unable to reach the coordinator. Set it before building anything you intend to deploy.",
      );
    }
    // Artifact bytes are fetched and uploaded directly from the browser to the
    // object store, so its origin must be named here. A `https:` wildcard would
    // readmit the entropy-exfiltration channel the threat model rules out, so
    // every permitted origin is explicit. Unset means artifacts are served by
    // the coordinator itself, which the coordinator origin already covers.
    const artifactOrigins = artifactConnectSources(
      process.env.ARTIFACT_ORIGINS,
    );
    const connectSources = [
      "'self'",
      ...(coordinatorOrigin ? [coordinatorOrigin] : []),
      ...artifactOrigins,
    ];
    const contentSecurityPolicy = [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src ${connectSources.join(" ")}`,
      "font-src 'self' data:",
      "form-action 'self' https://github.com",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      // Next's development runtime uses eval for source maps and Fast Refresh.
      // Production builds must retain the stricter script policy.
      `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      // Full document navigation to /collect is required: wallet frames are never
      // allowed in the contribution document. Only the pinned SDK origin is allowed.
      {
        source: "/collect",
        headers: [
          // The wallet authenticates its Penpal peer using document.referrer.
          // Send only the origin: never expose receipt IDs or other URL details.
          { key: "Referrer-Policy", value: "strict-origin" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy.replace("frame-src 'none'", "frame-src https://account.megaeth.com") },
          { key: "Permissions-Policy", value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=(), publickey-credentials-get=(self "https://account.megaeth.com"), publickey-credentials-create=(self "https://account.megaeth.com")' },
        ],
      },
    ];
  },
  // snarkjs spawns worker threads (ffjavascript + web-worker) for verifyChain's
  // curve math. Bundling rewrites the worker source, so workers never start and
  // verify hangs forever. Keep them external = runtime require from node_modules.
  // @wonderland/cabure-crypto is deliberately NOT listed: it is ESM and exposes a
  // "/worker" subpath. Externalizing it makes Next emit a bare runtime require for
  // that subpath, which fails to resolve and breaks the deployed build. Let it be
  // bundled; the snarkjs/ffjavascript it pulls in stay external via the block below.
  serverExternalPackages: ["snarkjs", "ffjavascript"],
  webpack: (config, { isServer, dev }) => {
    // Release builds only: dev compiles entries on demand and hot-reloads them,
    // and reordering them there breaks module loading.
    if (!dev) config.plugins.push(new DeterministicEntryOrderPlugin());
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    } else {
      // serverExternalPackages misses snarkjs when it is followed in through the
      // local cabure-crypto package. Force it here so require("snarkjs") stays a
      // runtime require from node_modules.
      const externals = ["snarkjs", "ffjavascript", "web-worker"];
      config.externals = Array.isArray(config.externals)
        ? [...config.externals, ...externals]
        : [config.externals, ...externals].filter(Boolean);
    }

    // ffjavascript's threadman uses a dynamic require() webpack can't analyze.
    // Works at runtime; silence the "Critical dependency" warning.
    config.module.exprContextCritical = false;

    return config;
  },
};

interface EntryOrderCompiler {
  hooks: {
    compilation: {
      tap(name: string, fn: (compilation: EntryOrderCompilation) => void): void;
    };
  };
}

interface EntryOrderCompilation {
  entries: Map<string, unknown>;
  hooks: { seal: { tap(name: string, fn: () => void): void } };
}

/**
 * Next registers page entries (and, from the server compiler, every app-router
 * client entry) in whatever order its parallel page analysis happens to
 * finish. Webpack numbers entrypoint chunk groups by insertion order, and the
 * client runtime lists its initial chunks in that order (`{6:0,426:0}` vs
 * `{426:0,6:0}`), so clean builds of one commit produced different
 * webpack-<hash>.js bytes and HTML references, defeating web release
 * reproduction. Sorting by name when sealing, before any chunk exists, picks
 * one order every time. Entries link by name (dependOn), so any order is
 * equally valid to webpack; this changes which output is chosen, not behaviour.
 */
class DeterministicEntryOrderPlugin {
  apply(compiler: EntryOrderCompiler) {
    const name = "DeterministicEntryOrderPlugin";
    compiler.hooks.compilation.tap(name, (compilation) => {
      compilation.hooks.seal.tap(name, () => {
        const { entries } = compilation;
        // Code-unit order, not localeCompare: it must not depend on the locale.
        const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        entries.clear();
        for (const [key, value] of sorted) entries.set(key, value);
      });
    });
  }
}

/**
 * A concrete origin, as CSP will read it: scheme, a literal host with no
 * wildcard, and an optional port. Nothing here may contain a CSP delimiter.
 */
const CSP_ORIGIN = /^https?:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/u;

/**
 * Guard an origin before it is interpolated into the policy.
 *
 * Two things the URL parser will happily accept but CSP must not. A host
 * containing `*` survives parsing and is a valid CSP source expression, so
 * `https://*` reinstates the wildcard this allowlist exists to remove, and
 * `https://*.example.com` hands an exfiltration sink to anyone who can
 * provision a name under it. And `;` or `,` in a host terminates the directive
 * or splits the header, silently truncating the policy.
 */
function assertCspOrigin(origin: string, variable: string): string {
  if (origin.includes("*")) {
    throw new Error(`${variable} must name concrete hosts; wildcards are not permitted`);
  }
  if (!CSP_ORIGIN.test(origin)) {
    throw new Error(`${variable} is not a usable Content-Security-Policy origin: ${origin}`);
  }
  return origin;
}

/**
 * Parse ARTIFACT_ORIGINS, a comma-separated allowlist of object-store origins
 * the browser may stream zkeys to and from: HTTPS or loopback HTTP, no
 * credentials, no path, query or fragment. Returns origins only.
 *
 * These must be dedicated origins that an attacker cannot write to. A shared
 * multi-tenant endpoint is an exfiltration sink even without a wildcard,
 * because an attacker can provision their own bucket on the same origin and a
 * compromised bundle may then post entropy to it within the policy.
 */
function artifactConnectSources(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const url = new URL(entry);
      if (url.username || url.password || url.search || url.hash) {
        throw new Error("ARTIFACT_ORIGINS contains forbidden URL components");
      }
      if (url.pathname !== "/" && url.pathname !== "") {
        throw new Error("ARTIFACT_ORIGINS entries must be origins, not paths");
      }
      const localHttp =
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !localHttp) {
        throw new Error("ARTIFACT_ORIGINS must use HTTPS or loopback HTTP");
      }
      return assertCspOrigin(url.origin, "ARTIFACT_ORIGINS");
    });
}

function coordinatorConnectSource(value: string | undefined): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("COORDINATOR_BASE_URL contains forbidden URL components");
  }
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("COORDINATOR_BASE_URL must use HTTPS or loopback HTTP");
  }
  return assertCspOrigin(url.origin, "COORDINATOR_BASE_URL");
}

/**
 * MOSS_WEB_BUILD_ID when set (for builds outside a Git checkout), otherwise the
 * full commit supplied by Vercel or the local Git checkout.
 */
function webBuildId(): string {
  const configured = process.env.MOSS_WEB_BUILD_ID;
  const id = configured ?? (() => {
    // Git-integrated Vercel builds expose the source SHA but omit .git.
    const vercelCommit = process.env.VERCEL_GIT_COMMIT_SHA;
    if (vercelCommit) {
      if (!/^[a-f0-9]{40}$/u.test(vercelCommit)) {
        throw new Error("VERCEL_GIT_COMMIT_SHA must be a full lowercase Git SHA");
      }
      return vercelCommit;
    }
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      throw new Error("set MOSS_WEB_BUILD_ID, enable Vercel system environment variables, or build from a Git checkout; the build ID must be reproducible");
    }
  })();
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new Error("web build ID is not a safe path segment");
  return id;
}

export default nextConfig;
