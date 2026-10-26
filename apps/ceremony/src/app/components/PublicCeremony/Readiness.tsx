"use client";
import { useEffect, useState } from "react";
import { getBrowserContributionCapabilities } from "@wonderland/cabure-crypto/browser";
import { describeBrowserCapabilityFailure } from "@/lib/capability-messages";
import { Button } from "@/app/components/Button";
import { DESKTOP_REQUIRED, isPhoneOrTablet } from "@/lib/contribution-device";
import journey from "./journey.module.css";
import { JourneyWindow } from "./JourneyWindow";

export function Readiness({
  inputBytes,
  onReady,
  onBack,
  preview = false,
}: {
  inputBytes: number;
  onReady: (overrideFailedCheck: boolean) => void;
  onBack: () => void;
  preview?: boolean;
}) {
  const [deviceBlocked, setDeviceBlocked] = useState<boolean | null>(null);
  useEffect(() => { setDeviceBlocked(isPhoneOrTablet(navigator)); }, []);
  const [checked, setChecked] = useState(false);
  const [overrideFailedCheck, setOverrideFailedCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awake, setAwake] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  async function check() {
    setBusy(true);
    setOverrideFailedCheck(false);
    setError(null);
    setChecked(false);
    try {
      if (!preview) {
        const result = await getBrowserContributionCapabilities({
          inputSizeBytes: inputBytes,
        });
        if (!result.supported)
          throw new Error(describeBrowserCapabilityFailure(result));
      }
      setChecked(true);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not check this browser. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (deviceBlocked !== false) {
    return (
      <section className={journey.journey}>
        <JourneyWindow>
          <div className={journey.enter} key={String(deviceBlocked)}>
            <h1 className={journey.title}>{deviceBlocked ? "Use a desktop to contribute" : "Checking your device…"}</h1>
            <p className={journey.lede} role="status">
              {deviceBlocked ? DESKTOP_REQUIRED : "Checking whether this device supports contribution setup."}
            </p>
          </div>
        </JourneyWindow>
        <div className={journey.actions}>
          <Button variant="secondary" onClick={onBack}>Back to homepage</Button>
        </div>
      </section>
    );
  }
  return (
    <section className={journey.journey}>
      <JourneyWindow>
        <div className={journey.enter}>
          <h1 className={journey.title}>Before you contribute</h1>
        </div>
        <dl className={journey.guide}>
          <div>
            <dt>Set aside 5–10 minutes</dt>
            <dd>
              Your contribution starts when you claim a slot. Queue time is extra,
              and slower devices or connections may need longer.
            </dd>
          </div>
          <div>
            <dt>Keep this tab visible until the upload finishes</dt>
            <dd>
              Use a desktop with a stable connection and keep it awake. Switching
              tabs, minimizing the browser, or leaving this page can interrupt
              your contribution and cause your slot to expire.
            </dd>
          </div>
        </dl>
      </JourneyWindow>
      <div className={journey.tray}>
        <div className={journey.plate}>
          <h2>Check your browser</h2>
          <p>
            The current artifact is {(inputBytes / 1e6).toFixed(1)} MB. Allow
            about {((2 * inputBytes + 64 * 1024 * 1024) / 1e9).toFixed(2)} GB of
            browser storage for input, output and headroom. Browser storage quota
            can be lower than your computer’s free disk space.
          </p>
          <Button
            variant="secondary"
            onClick={() => void check()}
            disabled={busy}
          >
            {busy
              ? "Checking…"
              : checked
                ? "Check again"
                : "Check browser & storage"}
          </Button>
          {checked && (
            <p role="status" className={`${journey.result} ${journey.enter}`}>
              Required browser APIs and available storage passed.
            </p>
          )}
          {error && (
            <div className={`${journey.override} ${journey.enter}`}>
              <div className={journey.error}><p role="alert">{error}</p></div>
              <label className={journey.check}>
                <input type="checkbox" checked={overrideFailedCheck}
                  onChange={(event) => setOverrideFailedCheck(event.target.checked)}
                  aria-describedby="readiness-override-help" />
                Proceed with ceremony anyway
              </label>
              <p id="readiness-override-help">
                The check may be inaccurate on your device. You can try anyway,
                but the contribution may still fail if storage or required browser
                features are unavailable.
              </p>
            </div>
          )}
        </div>
      </div>
      <div className={journey.tray}>
        <div className={`${journey.plate} ${journey.acks}`}>
          <label className={journey.check}>
            <input
              type="checkbox"
              checked={awake}
              onChange={(e) => setAwake(e.target.checked)}
            />
            I’m on a desktop and can keep it awake while I contribute.
          </label>
          <label className={journey.check}>
            <input
              type="checkbox"
              checked={privacy}
              onChange={(e) => setPrivacy(e.target.checked)}
            />
            I understand that my randomness must stay private. I won’t share it or send
            it to an operator.
          </label>
        </div>
      </div>
      <div className={journey.actions}>
        <Button
          variant="accent"
          disabled={!(checked || (error !== null && overrideFailedCheck)) || !awake || !privacy || busy}
          onClick={() => onReady(error !== null && overrideFailedCheck)}
        >
          Continue to contribution setup
        </Button>
        <Button variant="secondary" onClick={onBack}>
          Back to homepage
        </Button>
      </div>
    </section>
  );
}
