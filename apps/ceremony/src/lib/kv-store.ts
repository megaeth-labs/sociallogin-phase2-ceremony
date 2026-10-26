import { Redis } from "@upstash/redis";

const LOCK_TTL_SECONDS = 60;

let _redis: Redis | null = null;

function redis(): Redis {
  if (!_redis) {
    const url = process.env.KV_REST_API_URL?.trim();
    const token = process.env.KV_REST_API_TOKEN?.trim();
    if (!url || !token) {
      throw new Error(
        "KV_REST_API_URL and KV_REST_API_TOKEN must be set in the environment.",
      );
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

export async function getJson<T>(key: string): Promise<T | null> {
  return (await redis().get<T>(key)) ?? null;
}

/**
 * Atomically remove and return a JSON value. This is used for one-shot bearer
 * delivery: two concurrent pollers cannot both receive the same token.
 */
export async function takeJson<T>(key: string): Promise<T | null> {
  return (await redis().getdel<T>(key)) ?? null;
}

export async function setJson<T>(
  key: string,
  value: T,
  ttlSeconds?: number,
): Promise<void> {
  if (ttlSeconds !== undefined) {
    await redis().set(key, value, { ex: ttlSeconds });
  } else {
    await redis().set(key, value);
  }
}

// Acquire a single-holder key by SET NX with a TTL. This serializes polling the
// same GitHub Device Flow code across CLI requests.
export async function acquireLock(
  key: string,
  token: string,
  ttlSeconds: number = LOCK_TTL_SECONDS,
): Promise<boolean> {
  const result = await redis().set(key, token, {
    nx: true,
    ex: ttlSeconds,
  });
  return result === "OK";
}

// Release a lock only if the caller still holds it (token match), so a stalled
// holder whose TTL expired cannot delete a lock a second writer now owns.
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export async function releaseLock(key: string, token: string): Promise<void> {
  await redis().eval(RELEASE_LOCK_SCRIPT, [key], [token]);
}
