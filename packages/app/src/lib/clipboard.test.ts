import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyToClipboard } from "./clipboard";

// §15.x test for the clipboard utility. Three branches:
// 1) navigator.clipboard.writeText path (HTTPS / modern browsers)
// 2) <textarea> + document.execCommand("copy") fallback (insecure
//    context or denied permission)
// 3) hard-fail return false when both paths throw

const ORIG_CLIPBOARD = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "clipboard",
);

beforeEach(() => {
  // Restore document.execCommand because individual tests stub it.
  Object.defineProperty(document, "execCommand", {
    value: vi.fn(() => true),
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  // Restore the navigator.clipboard descriptor exactly as it was.
  if (ORIG_CLIPBOARD) {
    Object.defineProperty(navigator, "clipboard", ORIG_CLIPBOARD);
  } else {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
  vi.restoreAllMocks();
});

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    writable: true,
    configurable: true,
  });
}

describe("copyToClipboard (§15.x)", () => {
  it("returns true via navigator.clipboard.writeText on the happy path", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);

    const out = await copyToClipboard("hello world");

    expect(out).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello world");
  });

  it("falls back to execCommand('copy') when navigator.clipboard throws", async () => {
    stubClipboard(async () => {
      throw new Error("not allowed in insecure context");
    });
    const execSpy = document.execCommand as unknown as ReturnType<typeof vi.fn>;

    const out = await copyToClipboard("fallback-text");

    expect(out).toBe(true);
    expect(execSpy).toHaveBeenCalledWith("copy");
  });

  it("fallback creates a hidden textarea with the value, then removes it", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });

    let inDomDuringCopy: HTMLTextAreaElement | null = null;
    const execSpy = vi.fn(() => {
      inDomDuringCopy = document.querySelector("textarea");
      return true;
    });
    Object.defineProperty(document, "execCommand", {
      value: execSpy,
      writable: true,
      configurable: true,
    });

    const ok = await copyToClipboard("captured-text");
    expect(ok).toBe(true);

    // While execCommand ran, the textarea WAS in the DOM with our text.
    expect(inDomDuringCopy).not.toBeNull();
    expect((inDomDuringCopy as unknown as HTMLTextAreaElement).value).toBe(
      "captured-text",
    );

    // After return, the textarea is cleaned up.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("fallback positions the textarea off-screen (fixed + opacity=0)", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });

    let snapshot: { position: string; opacity: string } | null = null;
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        const ta = document.querySelector("textarea") as HTMLTextAreaElement;
        snapshot = { position: ta.style.position, opacity: ta.style.opacity };
        return true;
      }),
      writable: true,
      configurable: true,
    });

    await copyToClipboard("x");
    expect(snapshot).not.toBeNull();
    expect((snapshot as unknown as { position: string }).position).toBe("fixed");
    expect((snapshot as unknown as { opacity: string }).opacity).toBe("0");
  });

  it("returns false when BOTH navigator.clipboard AND execCommand throw", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        throw new Error("execCommand unavailable");
      }),
      writable: true,
      configurable: true,
    });

    const out = await copyToClipboard("nope");
    expect(out).toBe(false);
  });

  it("returns false when navigator.clipboard is missing AND appendChild throws", async () => {
    // Force the modern path to throw by deleting the API surface.
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;

    // Force the fallback path to throw before execCommand is even reached.
    const origAppend = document.body.appendChild.bind(document.body);
    document.body.appendChild = vi.fn(() => {
      throw new Error("DOM read-only");
    }) as unknown as typeof document.body.appendChild;

    const out = await copyToClipboard("anything");
    expect(out).toBe(false);

    document.body.appendChild = origAppend;
  });
});
