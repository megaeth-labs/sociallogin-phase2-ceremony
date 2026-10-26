/**
 * The tab running a participant's attempt holds this Web Lock from joining the
 * queue until the attempt ends. Other tabs use it to tell a running attempt
 * from one whose page was closed, and a second tab cannot start its own.
 */
export function contributionLockName(ceremonyId: string, participantId: string): string {
  return `moss-phase2-contribution:${ceremonyId}:${participantId}`;
}

export type ContributionLockState = "held" | "free" | "unsupported";

export interface ContributionLock {
  /** False when the browser has no Web Locks, so nothing is actually held. */
  supported: boolean;
  release: () => void;
}

function lockManager(): LockManager | null {
  return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null;
}

export async function contributionLockState(name: string): Promise<ContributionLockState> {
  const locks = lockManager();
  if (!locks) return "unsupported";
  try {
    const { held = [] } = await locks.query();
    return held.some((lock) => lock.name === name) ? "held" : "free";
  } catch {
    return "unsupported";
  }
}

/** Hold the lock until `release`; null when another tab already holds it. */
export async function acquireContributionLock(name: string): Promise<ContributionLock | null> {
  const locks = lockManager();
  if (!locks) return { supported: false, release: () => undefined };
  return await new Promise((resolve) => {
    locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return;
      }
      return new Promise<void>((release) => resolve({ supported: true, release }));
    }).catch(() => resolve({ supported: false, release: () => undefined }));
  });
}

/**
 * Run `task` while holding the lock, so no tab can start an attempt between
 * the check and the task. Null when another tab holds it. Without Web Locks
 * the task simply runs.
 */
export async function withContributionLockIfFree<T>(
  name: string,
  task: () => Promise<T>,
): Promise<T | null> {
  const locks = lockManager();
  if (!locks) return await task();
  return await locks.request(name, { ifAvailable: true }, async (lock) =>
    lock ? await task() : null,
  );
}
