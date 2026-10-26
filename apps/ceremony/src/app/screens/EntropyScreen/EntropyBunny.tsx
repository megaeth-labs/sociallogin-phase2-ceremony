"use client";

import { useEffect, useId, useRef, type RefObject } from "react";
import styles from "./EntropyBunny.module.css";

/**
 * Decorative frosted-glass bunny for the entropy field. It hops toward the
 * pointer, jumps on clicks and taps, and hops on key presses. It only reads
 * events from the field; entropy collection is untouched and the layer has no
 * pointer events of its own.
 *
 * One requestAnimationFrame loop writes transforms straight to the DOM, so no
 * React state changes per frame. Under reduced motion the bunny stays seated
 * and only turns to face the pointer.
 *
 * Embedded use (the lobby's randomness tile) passes a fixed `scale`, a smaller
 * `travel` for hop distances and heights, and `autonomous` so the bunny
 * wanders between random spots while nobody is pointing at it. Without those
 * props it behaves exactly as on the entropy screen.
 */

type Vec = { x: number; y: number };
type Phase = "idle" | "crouch" | "air" | "land";
type Hop = { from: Vec; to: Vec; dur: number; height: number; big: boolean };

const HOP_TRIGGER = 72;
const HOP_MAX = 150;
const BIG_HOP_MAX = 190;
/** Locomotion runs this many times faster than real time; idle motion does not. */
const HOP_SPEED = 2;
const CROUCH_MS = 90 / HOP_SPEED;
const BIG_CROUCH_MS = 140 / HOP_SPEED;
const LAND_MS = 110 / HOP_SPEED;
const BIT_COUNT = 14;
const MAX_PRINTS = 12;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export function EntropyBunny({
  areaRef,
  floorRef,
  celebrate = false,
  scale: fixedScale,
  travel = 1,
  autonomous = false,
  onLand,
}: {
  areaRef: RefObject<HTMLDivElement | null>;
  /** Element whose top edge is the lowest the bunny may hop to. */
  floorRef?: RefObject<HTMLElement | null>;
  celebrate?: boolean;
  /** Fixed body scale for small fields; the full-screen field sizes itself. */
  scale?: number;
  /** Multiplier for hop distances, hop heights and the click burst. */
  travel?: number;
  /** Wander to random spots when the pointer isn't over the field. */
  autonomous?: boolean;
  /** Called on every landing (decorative meters). */
  onLand?: () => void;
}) {
  const uid = useId().replace(/:/g, "");
  const layerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<SVGGElement>(null);
  const torsoRef = useRef<SVGGElement>(null);
  const headRef = useRef<SVGGElement>(null);
  const earNearRef = useRef<SVGGElement>(null);
  const earFarRef = useRef<SVGGElement>(null);
  const eyeRef = useRef<SVGGElement>(null);
  const noseRef = useRef<SVGGElement>(null);
  const tailRef = useRef<SVGGElement>(null);
  const api = useRef<{ jump: (p: Vec) => void; poke: () => void; binky: () => void } | null>(null);
  const landRef = useRef(onLand);
  landRef.current = onLand;

  useEffect(() => {
    const area = areaRef.current;
    const layer = layerRef.current;
    if (!area || !layer) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = motionQuery.matches;

    let width = layer.clientWidth;
    let height = layer.clientHeight;
    let bounds = { left: 0, right: 0, top: 0, bottom: 0 };
    const measure = () => {
      width = layer.clientWidth;
      height = layer.clientHeight;
      if (fixedScale) {
        // Leave room for the body (about 190 units tall, ±95 wide) and a hop.
        const top = Math.min(190 * fixedScale + 36 * travel, height - 8);
        bounds = { left: 95 * fixedScale, right: width - 95 * fixedScale, top, bottom: Math.max(top, height - 10) };
        return;
      }
      const floorTop = floorRef?.current?.getBoundingClientRect().top;
      const layerTop = layer.getBoundingClientRect().top;
      const floor = floorTop ? floorTop - layerTop - 16 : height - 48;
      const scale = baseScale();
      const top = Math.min(72 + 170 * scale, floor);
      bounds = {
        left: 100 * scale,
        right: width - 100 * scale,
        top,
        bottom: Math.max(top, floor),
      };
    };
    const baseScale = () => fixedScale ?? clamp(Math.min(width / 1100, height / 760), 0.58, 1);
    measure();

    const s = {
      pos: { x: width / 2, y: (bounds.top + bounds.bottom) / 2 + 40 } as Vec,
      target: null as Vec | null,
      queued: null as { to: Vec; big: boolean; height?: number } | null,
      phase: "idle" as Phase,
      phaseAt: 0,
      hop: null as Hop | null,
      nextHopAt: 0,
      z: 0,
      vz: 0,
      sq: 0,
      sqV: 0,
      facing: 1,
      turn: 1,
      turnV: 0,
      faceTarget: 1,
      tilt: 0,
      tiltV: 0,
      head: 0,
      headV: 0,
      ears: [0, 0],
      earsV: [0, 0],
      blinkAt: 0,
      blinkUntil: 0,
      twitchAt: 0,
      noseUntil: 0,
      tail: 0,
      cursor: null as Vec | null,
    };
    s.pos.y = clamp(s.pos.y, bounds.top, bounds.bottom);

    const local = (e: { clientX: number; clientY: number }): Vec => {
      const rect = layer.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const inBounds = (p: Vec): Vec => ({
      x: clamp(p.x, bounds.left, bounds.right),
      y: clamp(p.y, bounds.top, bounds.bottom),
    });

    const startHop = (now: number, to: Vec, big: boolean, heightOverride?: number) => {
      const dx = to.x - s.pos.x;
      const dy = to.y - s.pos.y;
      const dist = Math.hypot(dx, dy);
      const max = (big ? BIG_HOP_MAX : HOP_MAX) * travel;
      const step = Math.min(dist, max);
      const k = dist > 0 ? step / dist : 0;
      const dest = inBounds({ x: s.pos.x + dx * k, y: s.pos.y + dy * k });
      if (Math.abs(dx) > 6) s.faceTarget = Math.sign(dx);
      s.hop = {
        from: { ...s.pos },
        to: dest,
        dur: (big ? 520 : clamp(300 + step * 0.9, 300, 440)) / HOP_SPEED,
        height: (heightOverride ?? (big ? 120 + step * 0.1 : 24 + step * 0.22 / travel)) * travel,
        big,
      };
      s.phase = "crouch";
      s.phaseAt = now;
    };

    // Short-lived DOM nodes: the click burst and landing prints.
    const spawnBits = (p: Vec, count = BIT_COUNT) => {
      for (let i = 0; i < (reduced ? 1 : count); i++) {
        const bit = document.createElement("span");
        bit.className = reduced ? styles.mark : styles.bit;
        const angle = (i / BIT_COUNT) * Math.PI * 2 + rand(-0.3, 0.3);
        const dist = rand(34, 92) * travel;
        bit.style.left = `${p.x}px`;
        bit.style.top = `${p.y}px`;
        bit.style.setProperty("--tx", `${Math.cos(angle) * dist}px`);
        bit.style.setProperty("--ty", `${Math.sin(angle) * dist}px`);
        bit.style.setProperty("--r", `${rand(-90, 90)}deg`);
        bit.style.setProperty("--s", `${rand(0.7, 1.4)}`);
        layer.appendChild(bit);
        window.setTimeout(() => bit.remove(), 420);
      }
    };
    const spawnPrints = () => {
      const prints = layer.querySelectorAll(`.${styles.print}`);
      if (prints.length >= MAX_PRINTS) prints[0]?.remove();
      const print = document.createElement("span");
      print.className = styles.print;
      const scale = baseScale() * depth(s.pos.y);
      print.style.transform = `translate3d(${s.pos.x}px, ${s.pos.y}px, 0) scale(${scale * s.facing}, ${scale})`;
      layer.appendChild(print);
      window.setTimeout(() => print.classList.add(styles.printFade), 900);
      window.setTimeout(() => print.remove(), 1250);
    };

    // Slight perspective: nearer the bottom reads as closer.
    const depth = (y: number) => {
      const span = Math.max(1, bounds.bottom - bounds.top);
      return 0.86 + 0.2 * clamp((y - bounds.top) / span, 0, 1);
    };

    // Under reduced motion nothing animates on its own, so the loop only
    // runs for a frame after input instead of every frame.
    const wake = () => start();
    let pointerAt = -Infinity;
    let wanderAt = 0;
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      s.cursor = p;
      s.target = inBounds(p);
      pointerAt = performance.now();
      wake();
    };
    // Embedded fields forget the pointer when it leaves, so wandering resumes.
    const onLeave = () => {
      if (!autonomous) return;
      s.cursor = null;
      pointerAt = -Infinity;
    };
    const onUp = (e: PointerEvent) => {
      const p = local(e);
      spawnBits(p);
      s.cursor = p;
      api.current?.jump(p);
      wake();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      api.current?.poke();
      wake();
    };

    api.current = {
      jump: (p) => {
        s.noseUntil = performance.now() + 500;
        if (reduced) {
          if (Math.abs(p.x - s.pos.x) > 6) s.faceTarget = Math.sign(p.x - s.pos.x);
          return;
        }
        const to = inBounds(p);
        s.target = to;
        if (s.phase === "idle") startHop(performance.now(), to, true);
        else s.queued = { to, big: true };
      },
      poke: () => {
        s.noseUntil = performance.now() + 400;
        if (reduced || s.phase !== "idle") return;
        const to = { x: s.pos.x + s.faceTarget * rand(18, 46), y: s.pos.y + rand(-18, 18) };
        startHop(performance.now(), to, false, 30);
      },
      binky: () => {
        if (reduced) return;
        if (s.phase === "idle") startHop(performance.now(), { ...s.pos }, true, 150);
        else s.queued = { to: { ...s.pos }, big: true, height: 150 };
      },
    };

    area.addEventListener("pointermove", onMove, { passive: true });
    area.addEventListener("pointerleave", onLeave, { passive: true });
    area.addEventListener("pointerup", onUp, { passive: true });
    area.addEventListener("keydown", onKey);

    // The field can mount before it has a size (an embedded tile laid out
    // late); centre the bunny on the first real measurement.
    let placed = width > 0;
    const onResize = () => {
      measure();
      if (!placed && width > 0) {
        s.pos = { x: width / 2, y: (bounds.top + bounds.bottom) / 2 };
        placed = true;
      }
      s.pos = inBounds(s.pos);
      if (s.target) s.target = inBounds(s.target);
      wake();
    };
    window.addEventListener("resize", onResize);
    const sizeObserver = new ResizeObserver(onResize);
    sizeObserver.observe(area);
    const onMotion = () => {
      reduced = motionQuery.matches;
      wake();
    };
    motionQuery.addEventListener("change", onMotion);

    let raf = 0;
    let last = performance.now();
    const spring = (x: number, v: number, target: number, k: number, c: number, dt: number) => {
      const a = -k * (x - target) - c * v;
      v += a * dt;
      return [x + v * dt, v] as const;
    };

    // Set on unmount: observer callbacks or a frame already queued must not
    // restart the loop or touch refs that React has cleared.
    let disposed = false;
    const frame = (now: number) => {
      if (disposed || !bodyRef.current) {
        raf = 0;
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      // Body springs follow the hop clock; capped so the stiffest spring stays stable.
      const dtm = Math.min(0.05, dt * HOP_SPEED);
      last = now;
      const t = now / 1000;

      // ── Locomotion ───────────────────────────────────────────────
      if (!reduced) {
        // Wander: with nobody pointing, pick a fresh random spot every few seconds.
        if (autonomous && s.phase === "idle" && now - pointerAt > 2200 && now >= wanderAt) {
          s.target = inBounds({ x: rand(bounds.left, bounds.right), y: rand(bounds.top, bounds.bottom) });
          wanderAt = now + rand(1400, 3400);
          if (Math.random() < 0.18) s.queued = { to: s.target, big: true };
        }
        if (s.phase === "idle" && now >= s.nextHopAt) {
          if (s.queued) {
            startHop(now, s.queued.to, s.queued.big, s.queued.height);
            s.queued = null;
          } else if (s.target && Math.hypot(s.target.x - s.pos.x, s.target.y - s.pos.y) > HOP_TRIGGER * baseScale()) {
            startHop(now, s.target, false);
          }
        }
        if (s.phase === "crouch" && s.hop) {
          if (now - s.phaseAt >= (s.hop.big ? BIG_CROUCH_MS : CROUCH_MS)) {
            s.phase = "air";
            s.phaseAt = now;
            s.sqV += s.hop.big ? 5.5 : 3.6;
            s.earsV[0] -= s.hop.big ? 260 : 140;
            s.earsV[1] -= s.hop.big ? 220 : 120;
          }
        }
        if (s.phase === "air" && s.hop) {
          const u = clamp((now - s.phaseAt) / s.hop.dur, 0, 1);
          const prevZ = s.z;
          s.pos = {
            x: s.hop.from.x + (s.hop.to.x - s.hop.from.x) * u,
            y: s.hop.from.y + (s.hop.to.y - s.hop.from.y) * u,
          };
          s.z = 4 * s.hop.height * u * (1 - u);
          s.vz = dt > 0 ? (s.z - prevZ) / dt : 0;
          if (u >= 1) {
            s.z = 0;
            s.vz = 0;
            s.phase = "land";
            s.phaseAt = now;
            s.sqV -= s.hop.big ? 6.5 : 4.2;
            s.earsV[0] += s.hop.big ? 380 : 230;
            s.earsV[1] += s.hop.big ? 320 : 190;
            spawnPrints();
            // Wandering landings shed a few bits: randomness being gathered.
            if (autonomous && now - pointerAt > 2200) spawnBits({ x: s.pos.x, y: s.pos.y - 6 }, s.hop.big ? 8 : 3);
            landRef.current?.();
            s.hop = null;
          }
        }
        if (s.phase === "land" && now - s.phaseAt >= LAND_MS) {
          s.phase = "idle";
          s.nextHopAt = now + rand(40, 140) / HOP_SPEED;
        }
      } else {
        s.phase = "idle";
        s.z = 0;
        s.hop = null;
      }

      // Face the pointer when resting; keep hop direction in the air.
      if (s.phase === "idle" && s.cursor && Math.abs(s.cursor.x - s.pos.x) > 24) {
        s.faceTarget = Math.sign(s.cursor.x - s.pos.x);
      }

      // ── Secondary motion ─────────────────────────────────────────
      const airborne = s.phase === "air";
      const crouching = s.phase === "crouch";
      const u = airborne && s.hop ? clamp((now - s.phaseAt) / s.hop.dur, 0, 1) : 0;
      const sqTarget = crouching
        ? (s.hop?.big ? -0.2 : -0.13)
        : airborne
          ? (u < 0.4 ? 0.1 : u > 0.75 ? 0.05 : 0)
          : reduced ? 0 : 0.012 * Math.sin(t * 2.6);
      [s.sq, s.sqV] = spring(s.sq, s.sqV, sqTarget, 340, 19, dtm);

      const tiltTarget = airborne ? clamp((-s.vz / HOP_SPEED) * 0.03, -14, 14) * (s.hop?.big ? 1.25 : 1) : crouching ? 6 : 0;
      [s.tilt, s.tiltV] = spring(s.tilt, s.tiltV, tiltTarget, 220, 20, dtm);

      // Whip turn: flip at once, then let a horizontal squash spring back,
      // so the bunny never passes through a paper-thin frame.
      if (s.faceTarget !== s.facing) {
        s.facing = s.faceTarget;
        if (!reduced) {
          s.turn = 0.62;
          s.turnV = 0;
          s.headV -= 60;
        }
      }
      [s.turn, s.turnV] = reduced ? [1, 0] : spring(s.turn, s.turnV, 1, 520, 26, dtm);

      let headTarget = 0;
      if (s.cursor && !airborne) {
        const dir = Math.sign(s.facing) || 1;
        const lx = (s.cursor.x - s.pos.x) * dir;
        const ly = s.cursor.y - (s.pos.y - 110 * baseScale());
        headTarget = clamp((Math.atan2(ly, Math.max(lx, 40)) * 180) / Math.PI * 0.45, -16, 14);
      } else if (airborne) {
        headTarget = s.tilt * 0.4;
      }
      if (reduced) {
        s.head = headTarget;
      } else {
        [s.head, s.headV] = spring(s.head, s.headV, headTarget, 160, 16, dt);
      }

      if (!reduced) {
        if (now > s.twitchAt) {
          const ear = Math.random() < 0.5 ? 0 : 1;
          s.earsV[ear] += rand(-320, 320);
          s.twitchAt = now + rand(2600, 6400);
          if (Math.random() < 0.4) s.noseUntil = now + 380;
        }
        const sweep = airborne ? clamp((-s.vz / HOP_SPEED) * 0.05, -22, 26) : 0;
        for (let i = 0; i < 2; i++) {
          [s.ears[i], s.earsV[i]] = spring(s.ears[i], s.earsV[i], sweep + (i ? 4 : 0), 150, 9, dtm);
          s.ears[i] = clamp(s.ears[i], -38, 42);
        }
        if (now > s.blinkAt) {
          s.blinkUntil = now + 120;
          s.blinkAt = now + rand(2200, 5600);
        }
        s.tail = Math.sin(t * 7) * (now < s.noseUntil ? 1.4 : 0.4);
      } else {
        s.ears = [0, 4];
      }

      // ── Write transforms ─────────────────────────────────────────
      const scale = baseScale() * depth(s.pos.y);
      const sy = 1 + s.sq;
      const sx = 1 - s.sq * 0.55;
      const flip = s.facing * s.turn;
      bodyRef.current!.style.transform = `translate3d(${s.pos.x}px, ${s.pos.y - s.z * scale}px, 0) scale(${scale})`;
      const lift = clamp(s.z / 160, 0, 1);
      shadowRef.current!.style.transform = `translate3d(${s.pos.x}px, ${s.pos.y}px, 0) scale(${scale * (1 - lift * 0.45)})`;
      shadowRef.current!.style.opacity = `${1 - lift * 0.6}`;
      rigRef.current!.setAttribute("transform", `scale(${flip} 1)`);
      torsoRef.current!.setAttribute("transform", `scale(${sx} ${sy}) rotate(${-s.tilt} 0 -60)`);
      headRef.current!.setAttribute("transform", `rotate(${s.head} 30 -84)`);
      earNearRef.current!.setAttribute("transform", `rotate(${s.ears[0]} 38 -112)`);
      earFarRef.current!.setAttribute("transform", `rotate(${s.ears[1] - 6} 24 -108)`);
      eyeRef.current!.setAttribute(
        "transform",
        now < s.blinkUntil ? "translate(0 -97) scale(1 0.12) translate(0 97)" : "",
      );
      noseRef.current!.setAttribute(
        "transform",
        now < s.noseUntil && !reduced ? `translate(0 ${Math.sin(t * 46) * 0.9})` : "",
      );
      tailRef.current!.setAttribute("transform", `rotate(${s.tail * 6} -50 -40)`);

      raf = reduced ? 0 : requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf || disposed) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    // Run only while the tab is visible and the field is on screen.
    let onScreen = true;
    const sync = () => (document.hidden || !onScreen ? stop() : start());
    const onVisibility = sync;
    document.addEventListener("visibilitychange", onVisibility);
    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      sync();
    });
    observer.observe(layer);
    start();

    return () => {
      disposed = true;
      stop();
      api.current = null;
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      area.removeEventListener("pointermove", onMove);
      area.removeEventListener("pointerleave", onLeave);
      area.removeEventListener("pointerup", onUp);
      area.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      sizeObserver.disconnect();
      motionQuery.removeEventListener("change", onMotion);
      layer.querySelectorAll(`.${styles.bit}, .${styles.mark}, .${styles.print}`).forEach((n) => n.remove());
    };
  }, [areaRef, floorRef, fixedScale, travel, autonomous]);

  useEffect(() => {
    if (celebrate) api.current?.binky();
  }, [celebrate]);

  const g = (name: string) => `${uid}-${name}`;
  return (
    <div ref={layerRef} className={styles.layer} aria-hidden="true">
      <div ref={shadowRef} className={styles.shadow} />
      <div ref={bodyRef} className={styles.body}>
        <svg className={styles.svg} viewBox="-100 -190 200 200" width="200" height="200">
          <defs>
            <radialGradient id={g("frost")} cx="0.36" cy="0.26" r="0.9">
              <stop offset="0" className={styles.stopFrost} />
              <stop offset="0.6" className={styles.stopMist} />
              <stop offset="1" className={styles.stopShade} />
            </radialGradient>
            <radialGradient id={g("haunch")} cx="0.4" cy="0.3" r="0.65">
              <stop offset="0" className={styles.stopFrost} />
              <stop offset="1" className={styles.stopFrost} stopOpacity="0" />
            </radialGradient>
            <radialGradient id={g("occlusion")} cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" className={styles.stopDeep} stopOpacity="0.55" />
              <stop offset="1" className={styles.stopDeep} stopOpacity="0" />
            </radialGradient>
            <linearGradient id={g("far")} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className={styles.stopMist} />
              <stop offset="1" className={styles.stopShade} />
            </linearGradient>
            <linearGradient id={g("inner")} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className={styles.stopNeon} stopOpacity="0.08" />
              <stop offset="1" className={styles.stopNeon} stopOpacity="0.42" />
            </linearGradient>
            <path id={g("tail")} d="M-62 -44 C-66 -54 -56 -60 -50 -56 C-42 -58 -38 -48 -42 -42 C-44 -34 -56 -32 -60 -38 C-62 -40 -62 -42 -62 -44 Z" />
            <path id={g("body")} d="M-56 -22 C-66 -62 -34 -98 6 -96 C34 -95 50 -78 52 -58 C54 -36 46 -12 26 -6 L-34 -6 C-48 -6 -54 -13 -56 -22 Z" />
            <path id={g("foot")} d="M-42 -3 C-42 -9 -30 -11 -12 -10 C6 -9 18 -8 21 -4 C23 0 12 2 -10 2 C-30 2 -42 2 -42 -3 Z" />
            <path id={g("head")} d="M14 -94 C14 -114 30 -126 50 -124 C72 -122 84 -106 84 -89 C84 -74 72 -63 56 -62 C38 -61 24 -67 18 -77 C15 -82 14 -88 14 -94 Z" />
            <path id={g("earFar")} d="M18 -106 C8 -126 4 -158 12 -176 C17 -184 26 -180 29 -168 C33 -150 32 -124 30 -106 Z" />
            <path id={g("earNear")} d="M30 -110 C18 -130 16 -164 26 -182 C32 -191 42 -187 44 -174 C47 -154 46 -128 44 -110 Z" />
          </defs>
          <g ref={rigRef}>
            <g ref={torsoRef}>
              <g ref={tailRef}>
                <use href={`#${g("tail")}`} className={styles.rimLight} />
                <use href={`#${g("tail")}`} fill={`url(#${g("frost")})`} />
              </g>
              {/* Paws and hind foot sit behind the body so they read as tucked under it. */}
              <ellipse cx="45" cy="-4" rx="9" ry="5" fill={`url(#${g("far")})`} />
              <use href={`#${g("foot")}`} fill={`url(#${g("frost")})`} />
              <use href={`#${g("body")}`} className={styles.rimLight} />
              <use href={`#${g("body")}`} fill={`url(#${g("frost")})`} />
              <ellipse cx="-22" cy="-42" rx="28" ry="26" fill={`url(#${g("haunch")})`} />
              <path d="M-49 -28 C-46 -52 -28 -64 -8 -62" className={styles.crease} />
              {/* Near foreleg, drawn over the chest so the paw reads as part of it. */}
              <path
                d="M25 -46 C32 -40 35 -26 34 -12 C34 -8 36 -6.5 41 -6.5 C46.5 -6.5 48.5 -3 46 -0.8 C44 1 37 1 31 1 C25.5 1 22.5 -2 22.5 -6 C22.5 -18 21.5 -34 25 -46 Z"
                fill={`url(#${g("frost")})`}
              />
              <path d="M25 -44 C22 -32 22.5 -18 22.5 -6" className={styles.crease} />
              <path d="M40 -1 L41.5 -4.5 M44 -1 L45 -3.8" className={styles.toe} />
              <path d="M-36 -78 C-20 -88 2 -90 18 -86" className={styles.sheenLine} />
              <ellipse cx="32" cy="-70" rx="24" ry="13" fill={`url(#${g("occlusion")})`} />
              {/* Head with ears */}
              <g ref={headRef}>
                <g ref={earFarRef}>
                  <use href={`#${g("earFar")}`} className={styles.rimLight} />
                  <use href={`#${g("earFar")}`} fill={`url(#${g("far")})`} />
                </g>
                <use href={`#${g("head")}`} className={styles.rimLight} />
                <use href={`#${g("head")}`} fill={`url(#${g("frost")})`} />
                <ellipse cx="66" cy="-79" rx="14" ry="9" className={styles.muzzle} />
                <path d="M28 -114 C36 -121 50 -124 60 -120" className={styles.sheenLine} />
                <g ref={eyeRef}>
                  <ellipse cx="58" cy="-97" rx="6.2" ry="7.2" className={styles.eye} />
                  <ellipse cx="58" cy="-97" rx="6.2" ry="7.2" className={styles.eyeRing} />
                  <circle cx="60.4" cy="-99.8" r="2.1" className={styles.glint} />
                  <circle cx="56.4" cy="-94" r="0.9" className={styles.glint} />
                </g>
                <g ref={noseRef}>
                  <path d="M80 -89 C82.4 -89 84.2 -87.4 83.6 -85.8 C82.8 -84.2 80.4 -84.2 79.4 -85.8 C78.6 -87.2 79 -89 80 -89 Z" className={styles.nose} />
                  <path d="M81.2 -84.2 C80.8 -81.4 78.8 -80.2 76.6 -80.8" className={styles.mouth} />
                  <path d="M76 -85 L94 -89 M76 -83 L95 -81.5" className={styles.whisker} />
                </g>
                <g ref={earNearRef}>
                  <use href={`#${g("earNear")}`} className={styles.rimLight} />
                  <use href={`#${g("earNear")}`} fill={`url(#${g("frost")})`} />
                  <path
                    d="M31 -118 C25 -136 25 -160 31 -173 C35 -179 39 -175 40 -166 C41 -150 40 -132 38 -118 Z"
                    fill={`url(#${g("inner")})`}
                  />
                </g>
              </g>
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}
