// Development-only UI regression check. Never signs in or touches a ceremony.
// node experiments/public-ui/smoke.mjs http://127.0.0.1:3000 /path/to/playwright-core/index.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const origin = new URL(process.argv[2]);
assert.ok(["127.0.0.1", "localhost"].includes(origin.hostname));
const { chromium } = await import(pathToFileURL(process.argv[3]).href);
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  let ceremonyRequests = 0;
  const errors = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/v1/") || path.startsWith("/api/ceremony/"))
      ceremonyRequests++;
  });
  page.on("pageerror", () => errors.push("page error")); // No arbitrary error payloads.
  await page.goto(new URL("/preview", origin).href);
  await page.getByRole("button", { name: "Try the contribution flow" }).click();
  const continueButton = page.getByRole("button", {
    name: "Continue to example queue",
  });
  assert.equal(await continueButton.isDisabled(), true);
  await page.getByRole("button", { name: "Simulate browser check" }).click();
  const checkboxes = page.getByRole("checkbox");
  await checkboxes.nth(0).check();
  assert.equal(await continueButton.isDisabled(), true);
  await checkboxes.nth(1).check();
  await continueButton.click();
  await page.getByRole("heading", { name: "You’re in the queue." }).waitFor();
  assert.equal(await page.getByRole("progressbar").count(), 0);
  await page
    .getByRole("button", { name: "Preview a slot becoming available" })
    .click();
  await page.getByRole("heading", { name: "Your turn is ready." }).waitFor();
  await page.getByRole("button", { name: "Claim my slot" }).click();
  await page
    .getByRole("heading", { name: "Getting your starting point." })
    .waitFor();
  for (const heading of [
    "Your randomness. Your browser.",
    "Sending your contribution.",
    "Your contribution is being checked.",
  ]) {
    await page.getByRole("button", { name: "Preview next stage" }).click();
    await page.getByRole("heading", { name: heading }).waitFor();
  }
  assert.equal(await page.getByRole("progressbar").getAttribute("value"), null);
  await page.getByRole("button", { name: "Preview next stage" }).click();
  await page
    .getByRole("heading", { name: "You’re part of the ceremony." })
    .waitFor();
  await page
    .getByRole("button", { name: "View example receipt summary" })
    .click();
  await page
    .getByText("No signed receipt or artifact is generated in this preview.")
    .waitFor();
  await page.getByRole("button", { name: "Expired slot", exact: true }).click();
  await page.getByText("This offer has expired", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Claim my slot" }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Error", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Example: the upload was interrupted." })
    .waitFor();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("heading", { name: "A moment to get ready." }).waitFor();
  for (const screen of ["Sealed", "Finalized", "Lobby"]) {
    await page.getByRole("button", { name: screen, exact: true }).click();
    if (screen === "Sealed")
      await page
        .getByRole("heading", { name: "Waiting for the final beacon." })
        .waitFor();
    if (screen === "Finalized")
      await page
        .getByRole("heading", { name: "A shared foundation, complete." })
        .waitFor();
  }
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      `overflow at ${width}`,
    );
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Slot offer", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "Claim my slot" && !button.disabled,
    ),
  );
  await page.getByRole("button", { name: "Claim my slot" }).focus();
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Claim my slot",
  );
  assert.equal(ceremonyRequests, 0, "preview must not request ceremony APIs");
  assert.deepEqual(errors, []);
  console.log(
    "Passed: readiness, manual claim, all contribution stages, indeterminate verification, receipt explanation, expiry, retry, finalization, responsive widths, keyboard focus, zero ceremony API requests.",
  );
} finally {
  await browser.close();
}
