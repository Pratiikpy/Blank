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

describe("common/ErrorBoundary (§15.x)", () => {
  it("renders children unchanged when no error", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <span>healthy-child</span>
      </ErrorBoundary>,
    );
    expect(getByText("healthy-child")).toBeDefined();
  });

  it("renders default fallback UI when child throws", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      <ErrorBoundary>
        <ThrowOnRender />
      </ErrorBoundary>,
    );
    expect(getByText("Something went wrong")).toBeDefined();
    expect(getByText("Reload App")).toBeDefined();
    errSpy.mockRestore();
  });

  it("includes the error.message in the fallback body", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      <ErrorBoundary>
        <ThrowOnRender message="distinctive-msg-xyz" />
      </ErrorBoundary>,
    );
    expect(getByText(/distinctive-msg-xyz/)).toBeDefined();
    errSpy.mockRestore();
  });

  it("falls back to generic body when error message is empty", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      <ErrorBoundary>
        <ThrowOnRender message="" />
      </ErrorBoundary>,
    );
    expect(getByText(/An unexpected error occurred/)).toBeDefined();
    errSpy.mockRestore();
  });

  it("renders custom fallback when provided", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText, queryByText } = render(
      <ErrorBoundary fallback={<div>my-custom-fallback</div>}>
        <ThrowOnRender />
      </ErrorBoundary>,
    );
    expect(getByText("my-custom-fallback")).toBeDefined();
    // Default UI must NOT show.
    expect(queryByText("Something went wrong")).toBeNull();
    errSpy.mockRestore();
  });

  it("logs error + componentStack via lib/log", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <ThrowOnRender message="should-be-logged" />
      </ErrorBoundary>,
    );
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [event, errArg] = logErrorMock.mock.calls[0] as [string, Error];
    expect(event).toBe("errorBoundary.caught");
    expect(errArg).toBeInstanceOf(Error);
    expect(errArg.message).toBe("should-be-logged");

    expect(logWarnMock).toHaveBeenCalledTimes(1);
    const [warnEvent, warnCtx] = logWarnMock.mock.calls[0] as [
      string,
      { componentStack: string },
    ];
    expect(warnEvent).toBe("errorBoundary.context");
    expect(typeof warnCtx.componentStack).toBe("string");
    errSpy.mockRestore();
  });
});
