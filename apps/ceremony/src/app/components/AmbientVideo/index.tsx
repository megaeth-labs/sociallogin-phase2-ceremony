"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Safari is the only engine that composites HEVC alpha. Firefox now plays
 * QuickTime HEVC too but draws it on an opaque matte, so alpha footage can't
 * rely on <source> fallthrough; pick the file on the client instead.
 */
function prefersHevcAlpha() {
  const ua = navigator.userAgent;
  return /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|Android/.test(ua);
}

/**
 * A muted, looping decorative video that only plays when the viewer has not
 * asked for reduced motion; otherwise the poster stays as a still frame.
 *
 * For transparent footage pass `alpha`: Safari gets the HEVC `.mov` (the only
 * alpha it honours) and every other browser the VP9 `.webm`. The choice is made
 * after mount, so the poster shows until then.
 */
export function AmbientVideo({
  src,
  poster,
  alpha = false,
  className,
  width,
  height,
}: {
  /** Path without an extension; `.webm` plus `.mov` (alpha) or `.mp4` must exist. */
  src: string;
  poster: string;
  alpha?: boolean;
  className?: string;
  width?: number;
  height?: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [alphaSrc, setAlphaSrc] = useState<string | null>(null);
  useEffect(() => {
    if (alpha) setAlphaSrc(prefersHevcAlpha() ? `${src}.mov` : `${src}.webm`);
  }, [alpha, src]);
  useEffect(() => {
    const video = ref.current;
    if (!video || (alpha && !alphaSrc)) return;
    // Some environments (older engines, test DOMs) lack matchMedia or return
    // nothing from play(); treat both as "motion allowed, best effort".
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const sync = () => {
      if (query?.matches || document.hidden) video.pause?.();
      else void video.play?.()?.catch?.(() => {});
    };
    sync();
    query?.addEventListener?.("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      query?.removeEventListener?.("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [alpha, alphaSrc]);
  return (
    <video
      key={alphaSrc ?? "poster"}
      ref={ref}
      className={className}
      poster={poster}
      width={width}
      height={height}
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
      tabIndex={-1}
    >
      {alpha ? (
        alphaSrc && <source key={alphaSrc} src={alphaSrc} type={alphaSrc.endsWith(".mov") ? "video/quicktime" : "video/webm"} />
      ) : (
        <>
          <source src={`${src}.mp4`} type="video/mp4" />
          <source src={`${src}.webm`} type="video/webm" />
        </>
      )}
    </video>
  );
}
