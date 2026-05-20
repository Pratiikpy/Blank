import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import {
  PassphrasePromptProvider,
  usePassphrasePrompt,
  SigningOverlay,
  __resetPassphrasePromptForTests,
} from "./PassphrasePrompt";

// §15.x test for PassphrasePrompt — the global modal that gates
// every smart-wallet signature. The FIFO queue + auto-expire +
// promise-based API is the load-bearing surface; concurrent
// callers each get their own slot, cancelled callers don't leak
// promises forever, and the dialog has correct a11y wiring.

beforeEach(() => {
  vi.useFakeTimers();
  __resetPassphrasePromptForTests();
});

afterEach(() => {
  __resetPassphrasePromptForTests();
  vi.useRealTimers();
});

function Trigger({
  capture,
}: {
  capture: (api: ReturnType<typeof usePassphrasePrompt>) => void;
}) {
  const api = usePassphrasePrompt();
  capture(api);
  return null;
}

function setup() {
  let api: ReturnType<typeof usePassphrasePrompt> | null = null;
  const utils = render(
    <PassphrasePromptProvider>
      <Trigger capture={(a) => { api = a; }} />
    </PassphrasePromptProvider>,
  );
  return { ...utils, getApi: () => api! };
}

describe("PassphrasePrompt (§15.x)", () => {
  it("usePassphrasePrompt throws when used outside the provider", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Outside() {
      usePassphrasePrompt();
      return null;
    }
    expect(() => render(<Outside />)).toThrow(/Provider missing/);
    errSpy.mockRestore();
  });

  it("does NOT show the modal until request() is called", () => {
    const { queryByRole } = setup();
    expect(queryByRole("dialog")).toBeNull();
  });

  it("request() opens a dialog with role=dialog + aria-modal=true", () => {
    const { getApi, getByRole } = setup();
    act(() => {
      void getApi().request();
    });
    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("renders custom title + subtitle when provided", () => {
    const { getApi, getByText } = setup();
    act(() => {
      void getApi().request({ title: "Custom title", subtitle: "Custom subtitle" });
    });
    expect(getByText("Custom title")).toBeDefined();
    expect(getByText("Custom subtitle")).toBeDefined();
  });

  it("clicking the X button (Cancel) resolves the promise with null", async () => {
    const { getApi, getByLabelText } = setup();
    let resolved: string | null | undefined;
    act(() => {
      void getApi().request().then((v) => { resolved = v; });
    });

    fireEvent.click(getByLabelText("Cancel"));
    await act(async () => { await Promise.resolve(); });
    expect(resolved).toBeNull();
  });

  it("typing + Unlock button resolves with the typed value", async () => {
    const { getApi, container } = setup();
    let resolved: string | null | undefined;
    act(() => {
      void getApi().request().then((v) => { resolved = v; });
    });

    const input = container.querySelector('input[type="password"]')!;
    fireEvent.change(input, { target: { value: "my-passphrase" } });
    const submit = container.querySelector('button[type="submit"]')!;
    fireEvent.click(submit);

    await act(async () => { await Promise.resolve(); });
    expect(resolved).toBe("my-passphrase");
  });

  it("Unlock button is disabled until the input has a value", () => {
    const { getApi, container } = setup();
    act(() => {
      void getApi().request();
    });
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const input = container.querySelector('input[type="password"]')!;
    fireEvent.change(input, { target: { value: "x" } });
    expect(submit.disabled).toBe(false);
  });

  it("auto-expires queued requests after the 60s timeout (resolves with null)", async () => {
    const { getApi } = setup();
    let resolved: string | null | undefined;
    act(() => {
      void getApi().request().then((v) => { resolved = v; });
    });

    // Fast-forward past the 60s entry timeout.
    await act(async () => {
      vi.advanceTimersByTime(60_001);
      await Promise.resolve();
    });
    expect(resolved).toBeNull();
  });
});

describe("SigningOverlay (§15.x)", () => {
  it("renders nothing when visible=false", () => {
    const { container } = render(<SigningOverlay visible={false} label="Signing..." />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the label text when visible=true", () => {
    const { getByText } = render(<SigningOverlay visible={true} label="Encrypting..." />);
    expect(getByText("Encrypting...")).toBeDefined();
  });
});
