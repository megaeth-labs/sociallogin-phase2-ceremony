import CeremonyPage from "./ceremony-page";
import { PublicCeremonyPreview } from "./preview/preview";
import { rehearsalReviewEnabled, reviewBackendReady } from "@/lib/rehearsal-review";

export const dynamic = "force-dynamic";
export default async function Page() {
  if (rehearsalReviewEnabled()) {
    const backendReady = await reviewBackendReady(process.env.COORDINATOR_BASE_URL);
    return <PublicCeremonyPreview hostedReview backendReady={backendReady} />;
  }
  return <CeremonyPage collectiblesEnabled={process.env.NFT_CLAIMS_ENABLED === "true"} />;
}
