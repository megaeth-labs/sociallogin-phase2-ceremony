import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ useSession: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("next-auth/react", () => auth);
import { AccountMenu } from "./index";

describe("account identity", () => {
  it("shows the GitHub handle instead of an ambiguous connected state or display name", () => {
    auth.useSession.mockReturnValue({ status: "authenticated", data: { participantName: "github-handle", user: { name: "Display Name", email: "private@example.com" } } });
    const html = renderToStaticMarkup(<AccountMenu />);
    expect(html).toContain("@github-handle");
    expect(html).toContain("Signed in with GitHub");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("private@example.com");
    expect(html).not.toContain("Display Name");
  });
  it("does not flash sign-in while the session loads", () => {
    auth.useSession.mockReturnValue({ status: "loading", data: null });
    const html = renderToStaticMarkup(<AccountMenu />);
    expect(html).toContain("Checking sign-in");
    expect(html).not.toContain("Sign in with GitHub");
  });
  it("offers GitHub sign-in when signed out", () => {
    auth.useSession.mockReturnValue({ status: "unauthenticated", data: null });
    expect(renderToStaticMarkup(<AccountMenu />)).toContain("Sign in with GitHub");
  });
});
