import { notFound } from "next/navigation";
import { screenReviewEnabled } from "@/lib/rehearsal-review";
import { PublicCeremonyPreview } from "../preview/preview";

export const dynamic = "force-dynamic";
export default function ReviewPage() {
  if (!screenReviewEnabled()) notFound();
  return <PublicCeremonyPreview />;
}
