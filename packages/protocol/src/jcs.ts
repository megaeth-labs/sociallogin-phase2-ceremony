import { createHash } from "node:crypto";

import type { JsonValue } from "./types.js";

const UNPAIRED_SURROGATE = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF])/u;

/** RFC 8785-compatible canonical JSON for I-JSON values. */
export function canonicalize(value: JsonValue): string {
  const stack = new Set<object>();

  const encode = (item: JsonValue): string => {
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("JCS numbers must be finite");
      return JSON.stringify(item);
    }
    if (typeof item === "string") {
      if (UNPAIRED_SURROGATE.test(item)) throw new Error("JCS strings must contain valid Unicode scalar values");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") throw new Error("JCS input contains a non-JSON value");
    if (stack.has(item)) throw new Error("JCS input contains a cycle");
    stack.add(item);
    try {
      if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
      const record = item as Record<string, JsonValue>;
      const entries = Object.keys(record).sort().map((key) => {
        if (UNPAIRED_SURROGATE.test(key)) throw new Error("JCS object keys must contain valid Unicode scalar values");
        const valueAtKey = record[key];
        if (valueAtKey === undefined) throw new Error("JCS input contains undefined");
        return `${JSON.stringify(key)}:${encode(valueAtKey)}`;
      });
      return `{${entries.join(",")}}`;
    } finally {
      stack.delete(item);
    }
  };

  return encode(value);
}

export function canonicalSha256(domain: string, value: JsonValue): string {
  if (domain.length === 0 || domain.includes("\0")) throw new Error("hash domain is invalid");
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0")
    .update(canonicalize(value), "utf8")
    .digest("hex");
}
