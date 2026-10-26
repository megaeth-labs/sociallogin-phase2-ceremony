import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { VerificationPassInput, VerificationPassOutput, VerificationPassRunner } from "./types.js";

const MAX_OUTPUT_BYTES = 64 * 1024;

export class IsolatedPassRunner implements VerificationPassRunner {
  async run(
    input: VerificationPassInput,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<VerificationPassOutput> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("verification timeout is invalid");
    const childPath = fileURLToPath(new URL("./verify-child.js", import.meta.url));
    return await new Promise<VerificationPassOutput>((resolve, reject) => {
      const child = spawn(process.execPath, [childPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "production" },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutLength = 0;
      let stderrLength = 0;
      let settled = false;
      const finish = (error?: Error, output?: VerificationPassOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(output!);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("verification pass timed out"));
      }, timeoutMs);
      timer.unref();
      const abort = () => {
        child.kill("SIGKILL");
        finish(signal?.reason instanceof Error ? signal.reason : new Error("verification pass aborted"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutLength += chunk.byteLength;
        if (stdoutLength > MAX_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(new Error("verification child output exceeds limit"));
        } else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrLength += chunk.byteLength;
        if (stderrLength <= MAX_OUTPUT_BYTES) stderr.push(chunk);
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        if (code !== 0) return finish(new Error(`verification child exited abnormally (${code ?? signal ?? "unknown"})`));
        try {
          const value = JSON.parse(Buffer.concat(stdout).toString("utf8")) as VerificationPassOutput;
          assertPassOutput(value, input);
          finish(undefined, value);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("verification child returned invalid JSON"));
        }
      });
      child.stdin.on("error", (error) => finish(error));
      child.stdin.end(JSON.stringify(input));
    });
  }
}

function assertPassOutput(value: VerificationPassOutput, input: VerificationPassInput): void {
  if (value === null || typeof value !== "object") throw new Error("verification child output is invalid");
  if (value.result !== "valid" && value.result !== "invalid") throw new Error("verification child result is invalid");
  if (typeof value.prefixValid !== "boolean" || typeof value.verifyFromInit !== "boolean") {
    throw new Error("verification child checks are invalid");
  }
  if (value.observedContributionName !== null
    && (typeof value.observedContributionName !== "string"
      || /[\u0000-\u001f\u007f]/u.test(value.observedContributionName)
      || Buffer.byteLength(value.observedContributionName, "utf8") < 1
      || Buffer.byteLength(value.observedContributionName, "utf8") > 255)) {
    throw new Error("verification child observed contribution name is invalid");
  }
  if (value.observedContributionHashBlake2b512 !== null
    && (typeof value.observedContributionHashBlake2b512 !== "string"
      || !/^[a-f0-9]{128}$/u.test(value.observedContributionHashBlake2b512))) {
    throw new Error("verification child observed contribution hash is invalid");
  }
  if (value.observedContributionIndex !== null
    && (!Number.isSafeInteger(value.observedContributionIndex)
      || value.observedContributionIndex < 1
      || value.observedContributionIndex > 1_000_000)) {
    throw new Error("verification child observed contribution index is invalid");
  }
  if (value.result === "valid" && (!value.prefixValid || !value.verifyFromInit)) {
    throw new Error("verification child returned inconsistent success");
  }
  if (value.result === "valid" && (
    value.observedContributionName !== input.expectedContributionName
    || value.observedContributionHashBlake2b512 !== input.expectedContributionHashBlake2b512
    || value.observedContributionIndex !== input.maxPredecessorContributions + 1
  )) {
    throw new Error("verification child returned mismatched contribution metadata");
  }
}
