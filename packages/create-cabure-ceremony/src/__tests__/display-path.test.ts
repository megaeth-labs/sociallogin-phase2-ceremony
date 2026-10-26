import { describe, expect, test } from "vitest";

import { toDisplayPath } from "../display-path.js";

describe("toDisplayPath", () => {
  test("returns dot for the same directory", () => {
    expect(toDisplayPath("/a/b", "/a/b")).toBe(".");
  });

  test("prefixes ./ for child paths", () => {
    expect(toDisplayPath("/a/b/c", "/a/b")).toBe("./c");
  });

  test("prefixes ./ for nested child paths", () => {
    expect(toDisplayPath("/a/b/c/d", "/a/b")).toBe("./c/d");
  });

  test("returns .. paths as-is", () => {
    expect(toDisplayPath("/a", "/a/b")).toBe("..");
  });

  test("returns multi-level .. paths as-is", () => {
    expect(toDisplayPath("/x", "/a/b/c")).toBe("../../../x");
  });
});
