import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/log", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { ErrorBoundary } from "./ErrorBoundary";
import { log } from "@/lib/log";

const logErrorMock = (log as unknown as { error: ReturnType<typeof vi.fn> }).error;
const logWarnMock = (log as unknown as { warn: ReturnType<typeof vi.fn> }).warn;

beforeEach(() => {
  logErrorMock.mockReset();
  logWarnMock.mockReset();
});

function ThrowOnRender({ message = "boom" }: { message?: string }): React.ReactNode {
  throw new Error(message);
}

describe("ErrorBoundary (§15.x)", () => {
  it("renders children unchanged when no error is thrown", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <span>healthy-child</span>
      </ErrorBoundary>,
    );
    expect(getByText("healthy-child")).toBeDefined();
  });

  it("renders the default fallback UI when child throws", () => {
    // Suppress React's error-boundary warning during this test.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      <ErrorBoundary>
        <ThrowOnRender message="render-time fault" />
      </ErrorBoundary>,
    );
    expect(getByText("Something broke")).toBeDefined();
    expect(getByText(/error has been logged/i)).toBeDefined();
    errSpy.mockRestore();
  });

  it("includes the error message in the details section", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      <ErrorBoundary>
        <ThrowOnRender message="distinctive-token-xyz" />
      </ErrorBoundary>,
    );
    expect(getByText(/distinctive-token-xyz/)).toBeDefined();
    errSpy.mockRestore();
  });

  it("renders the custom fallback when provided (overrides default UI)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText, queryByText } = render(
      <ErrorBoundary fallback={<div>my-custom-fallback</div>}>
        <ThrowOnRender />
      </ErrorBoundary>,
    );
    expect(getByText("my-custom-fallback")).toBeDefined();
    // Default UI must NOT appear when a custom fallback is present.
    expect(queryByText("Something broke")).toBeNull();
    errSpy.mockRestore();
  });

  it("calls log.error with the caught Error (event=errorBoundary.caught)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <ThrowOnRender message="error-to-log" />
      </ErrorBoundary>,
    );
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [event, errArg] = logErrorMock.mock.calls[0] as [string, Error];
    expect(event).toBe("errorBoundary.caught");
    expect(errArg).toBeInstanceOf(Error);
    expect(errArg.message).toBe("error-to-log");
    errSpy.mockRestore();
  });

  it("calls log.warn with the componentStack", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <ThrowOnRender />
      </ErrorBoundary>,
    );
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    const [event, ctx] = logWarnMock.mock.calls[0] as [string, { stack?: string }];
    expect(event).toBe("errorBoundary.componentStack");
    expect(typeof ctx.stack).toBe("string");
    errSpy.mockRestore();
  });
});
