import type { SignedEnvelope, VerificationReportV1 } from "@moss/phase2-protocol";
import { assertIsoDate, assertUuid } from "@moss/phase2-protocol";

import { assertVerificationJob } from "./validation.js";
import type { VerificationJobV1 } from "./types.js";

export class CoordinatorClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly bearerToken: string,
    private readonly operatorKeyId: string,
    private readonly maxArtifactByteLength: number,
  ) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== "https:" && this.baseUrl.protocol !== "http:") throw new Error("coordinator URL is unsupported");
    if (!/^[A-Za-z0-9._~-]{32,512}$/u.test(bearerToken)) throw new Error("internal bearer token is malformed");
  }

  async claim(signal?: AbortSignal): Promise<VerificationJobV1 | null> {
    const response = await this.request("/v1/internal/verifier/jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operatorKeyId: this.operatorKeyId }),
      signal,
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`coordinator job claim failed with status ${response.status}`);
    const value: unknown = await response.json();
    assertVerificationJob(value, this.maxArtifactByteLength);
    return value;
  }

  async report(envelope: SignedEnvelope<VerificationReportV1>, signal?: AbortSignal): Promise<void> {
    const response = await this.request("/v1/internal/verifier/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal,
    });
    if (!response.ok) throw new Error(`coordinator report submission failed with status ${response.status}`);
  }

  async heartbeat(jobId: string, signal?: AbortSignal): Promise<string> {
    assertUuid(jobId, "jobId");
    const response = await this.request(
      `/v1/internal/verifier/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`coordinator job heartbeat failed with status ${response.status}`);
    }
    const value = await response.json() as { leaseExpiresAt?: unknown };
    if (typeof value.leaseExpiresAt !== "string") {
      throw new Error("coordinator job heartbeat response is invalid");
    }
    assertIsoDate(value.leaseExpiresAt, "leaseExpiresAt");
    return value.leaseExpiresAt;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    return await fetch(new URL(path, this.baseUrl), {
      ...init,
      redirect: "error",
      headers: { ...init.headers, authorization: `Bearer ${this.bearerToken}` },
    });
  }
}
