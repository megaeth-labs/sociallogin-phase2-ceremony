import { CollectPage } from "./view";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ receiptId?: string }>;
}) {
  const params = await searchParams;
  const id =
    typeof params.receiptId === "string" &&
    /^[0-9a-f-]{36}$/i.test(params.receiptId)
      ? params.receiptId
      : null;
  return <CollectPage receiptId={id} />;
}
