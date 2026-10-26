import type { Metadata } from "next";
import { HowItWorks } from "./HowItWorks";

export const metadata: Metadata = {
  title: "How the MOSS social login ceremony works",
  description:
    "Every step of the MOSS social login ceremony, from joining the queue to the published key.",
};

export const dynamic = "force-dynamic";
export default function Page() {
  return <HowItWorks collectiblesEnabled={process.env.NFT_CLAIMS_ENABLED === "true"} />;
}
