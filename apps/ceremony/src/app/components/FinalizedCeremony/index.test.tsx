import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FinalizedCeremony } from "./index";
import record from "@/lib/rehearsal-finalization.json";
it("shows completed rehearsal downloads, proof-test scope and evidence boundaries", () => {
  const html = renderToStaticMarkup(<FinalizedCeremony result={record.payload} />);
  expect(html).toContain("Rehearsal complete");
  expect(html).toContain("567.4 MB");
  expect(html).toContain("Two fresh proofs from one synthetic fixture");
  expect(html).toContain("must not be used in production");
  expect(html).toContain("checkpoint remains sealed");
  expect(html).toContain(record.payload.artifacts.finalZkey.sha256);
  for (const artifact of Object.values(record.payload.artifacts)) expect(html).toContain(artifact.url.replaceAll("&", "&amp;"));
  expect(html).not.toContain("Join the queue");
});

it("shows a completed production ceremony without rehearsal labels", async () => {
  const { SAMPLE_PRODUCTION_FINALIZATION: result } = await import("@/app/preview/sample-finalization");
  const html = renderToStaticMarkup(<FinalizedCeremony result={result} />);
  expect(html).not.toContain("Rehearsal");
  expect(html).not.toContain("must not be used in production");
  expect(html).toContain("7 accepted contributions, then one public beacon from block 26,108,000");
  expect(html).toContain("7 contributions replayed · 7 receipts checked");
  expect(html).toContain("2 fresh proofs from 1 fixture · 4 Solidity tests");
  expect(html).toContain('href="/finalization.signed.json"');
  for (const artifact of Object.values(result.artifacts)) expect(html).toContain(artifact.sha256);
  expect(html).not.toContain("Join the queue");
});
