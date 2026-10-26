const { chromium } = require("playwright-core");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const sdkRequire = createRequire(require.resolve("@megaeth-labs/wallet-sdk"));
// Run against a local production build on port 3108. All wallet/API responses
// are synthetic, and every external request is blocked or fulfilled locally.
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
  });
  const page = await context.newPage();
  let confirmed = false,
    claimRequests = 0,
    walletCalls = 0;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    address = "0x" + "1".repeat(40),
    hash = "0x" + "2".repeat(64);
  const badge = {
    enabled: true,
    network: "testnet",
    chainId: 6343,
    contractAddress: "0x" + "3".repeat(40),
    receiptHash: hash,
    tokenId: "123",
    contributionIndex: 2,
    transferable: false,
    claimedBy: null,
    owner: null,
    explorerBaseUrl: "https://explorer.example",
  };
  const penpal = fs.readFileSync(
    join(dirname(sdkRequire.resolve("penpal")), "penpal.js"),
    "utf8",
  );
  await page.exposeFunction("testMintCalled", () => {
    walletCalls++;
    confirmed = true;
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "https://account.megaeth.com")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>${penpal}</script><script>
  if(document.referrer!=='http://localhost:3108/')throw Error('Wallet requires an origin-only referrer');
  let connected=false;const status=()=>({status:connected?'connected':'disconnected',address:'${address}',network:'testnet'});
  const connection=Penpal.connect({messenger:new Penpal.WindowMessenger({remoteWindow:parent,allowedOrigins:['http://localhost:3108']}),methods:{status,connect:()=>{connected=true;return status()},disconnect:()=>{connected=false;return status()},callContract:async request=>{if(request.functionName!=='claim'||request.silent!==false||request.sponsor!==false)throw Error('Unexpected call');await window.testMintCalled();return {status:'approved',receipt:{transactionHash:'0x${"a".repeat(64)}'}}},collectible:()=>{}}});connection.promise.then(async p=>{await new Promise(r=>setTimeout(r,30));await p.ready()});</script>`,
      });
    if (url.hostname !== "localhost") return route.abort();
    if (url.pathname === "/api/auth/session")
      return route.fulfill({
        json: {
          user: { name: "Alice" },
          participantId: id,
          expires: "2099-01-01T00:00:00Z",
        },
      });
    if (url.pathname === "/api/ceremony/nft") {
      if (route.request().method() === "POST") {
        claimRequests++;
        return route.fulfill({
          json: {
            status: badge,
            voucher: {
              recipient: address,
              receiptHash: hash,
              contributionIndex: "2",
              deadline: "2000000000",
              signature: "0x1234",
            },
          },
        });
      }
      return route.fulfill({
        json: confirmed
          ? { ...badge, claimedBy: address, owner: address }
          : badge,
      });
    }
    return route.continue();
  });
  try {
    const response = await page.goto(
      "http://localhost:3108/collect?receiptId=" + id,
    );
    if (response.headers()["referrer-policy"] !== "strict-origin")
      throw Error("Collect must expose only the embedding origin");
    const csp = response.headers()["content-security-policy"];
    if (
      !csp.includes("frame-src https://account.megaeth.com") ||
      csp.includes("frame-src 'none'")
    )
      throw Error("Collect CSP override incorrect");
    await page.getByRole("button", { name: "Connect MOSS Wallet" }).waitFor();
    if (await page.locator("iframe").count())
      throw Error("Wallet loaded before Connect");
    await page.screenshot({
      path: join(tmpdir(), "moss-nft-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Connect MOSS Wallet" }).click();
    await page.getByRole("button", { name: "Disconnect" }).waitFor();
    const mint = page.getByRole("button", { name: "Mint my collectible" });
    if (await mint.isEnabled()) throw Error("Missing link consent");
    await page.getByRole("checkbox").check();
    await mint.click();
    await page.getByText("Collectible minted").waitFor();
    await page.reload();
    await page.getByText("Collectible minted").waitFor();
    if (walletCalls !== 1 || claimRequests !== 1)
      throw Error("Unexpected duplicate mint");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: join(tmpdir(), "moss-nft-mobile.png"),
      fullPage: true,
    });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw Error("Horizontal overflow");
    const home = await page.goto("http://localhost:3108/");
    if (!home.headers()["content-security-policy"].includes("frame-src 'none'"))
      throw Error("Contribution frame policy widened");
    if (await page.locator("iframe").count())
      throw Error("Wallet frame survived document navigation");
    if (errors.length) throw Error(errors.join(";"));
    console.log(
      "PASS Chrome: actual npm SDK / synthetic wallet handshake, explicit approval, RPC-confirmed UI, reload recovery, route-scoped CSP, desktop/mobile layouts; zero live minting",
    );
  } finally {
    await context.unrouteAll({ behavior: "ignoreErrors" });
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
