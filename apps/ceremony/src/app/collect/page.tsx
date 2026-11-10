import { redirect } from "next/navigation";
import { CollectPage } from "./view";
import { ceremonyArchive } from "@/lib/ceremony-archive";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ receiptId?: string }>;
}) {
  // Claims closed with the ceremony; its archive is the homepage.
  if (ceremonyArchive()) redirect("/");
  const params = await searchParams;
  const id =
    typeof params.receiptId === "string" &&
    /^[0-9a-f-]{36}$/i.test(params.receiptId)
      ? params.receiptId
      : null;
  return <CollectPage receiptId={id} />;
}
