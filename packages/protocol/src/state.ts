import type { CeremonyState, LeaseState } from "./types.js";

const CEREMONY_TRANSITIONS: Readonly<Record<CeremonyState, readonly CeremonyState[]>> = {
  DRAFT: ["PREPARING", "CANCELLED"],
  PREPARING: ["PREPARED", "CANCELLED"],
  // A ceremony that never opened and whose sealing instant has passed seals
  // directly. The coordinator has always done this; the table did not say so.
  PREPARED: ["OPEN", "SEALED", "CANCELLED"],
  OPEN: ["PAUSED", "SEALED", "ABORTED"],
  PAUSED: ["OPEN", "SEALED", "ABORTED"],
  SEALED: ["WAITING_FOR_BEACON", "ABORTED"],
  WAITING_FOR_BEACON: ["FINALIZING", "ABORTED"],
  FINALIZING: ["FINALIZED", "WAITING_FOR_BEACON", "ABORTED"],
  FINALIZED: [],
  CANCELLED: [],
  ABORTED: [],
};

const LEASE_TRANSITIONS: Readonly<Record<LeaseState, readonly LeaseState[]>> = {
  OFFERED: ["ACTIVE", "EXPIRED", "CANCELLED"],
  ACTIVE: ["SUBMITTED", "EXPIRED", "CANCELLED"],
  SUBMITTED: ["VERIFYING", "REJECTED", "STALE"],
  VERIFYING: ["ACCEPTED", "REJECTED", "STALE"],
  ACCEPTED: [],
  EXPIRED: [],
  REJECTED: [],
  STALE: [],
  CANCELLED: [],
};

export function assertCeremonyTransition(from: CeremonyState, to: CeremonyState): void {
  // An out-of-band `from` must be a protocol error, not a TypeError raised by
  // indexing the table with it.
  const allowed = CEREMONY_TRANSITIONS[from];
  if (!allowed) throw new Error(`unknown ceremony state ${from}`);
  if (!allowed.includes(to)) throw new Error(`invalid ceremony transition ${from} -> ${to}`);
}

export function assertLeaseTransition(from: LeaseState, to: LeaseState): void {
  const allowed = LEASE_TRANSITIONS[from];
  if (!allowed) throw new Error(`unknown lease state ${from}`);
  if (!allowed.includes(to)) throw new Error(`invalid lease transition ${from} -> ${to}`);
}
