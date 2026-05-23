import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { LoadingSkeleton } from "./LoadingSkeleton";

// Wave 5 Block 6 — state-primitives tests.
//
// Locks the public API of the three reusable state components so
// downstream screens that depend on them don't regress quietly.

describe("EmptyState", () => {
  it("renders title + body and no CTA when omitted", () => {
    render(<EmptyState title="No data" body="Nothing to show yet." />);
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(screen.getByText("Nothing to show yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-state-cta")).toBeNull();
  });

  it("renders an onClick CTA as a button", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="No data"
        body="Try a different filter."
        cta={{ label: "Reset", onClick }}
      />,
    );
    fireEvent.click(screen.getByTestId("empty-state-cta"));
    expect(onClick).toHaveBeenCalled();
  });

  it("renders an href CTA as an anchor", () => {
    render(
      <EmptyState
        title="No data"
        body="Visit /app/send to send the first one."
        cta={{ label: "Open send", href: "/app/send" }}
      />,
    );
    const link = screen.getByTestId("empty-state-cta") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/app/send");
  });
});

describe("ErrorState", () => {
  it("shows default title when none provided", () => {
    render(<ErrorState />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("shows custom title + message + retry CTA", () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        title="RPC failed"
        message="The Sepolia RPC returned 503. Falling back to public node."
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("RPC failed")).toBeInTheDocument();
    expect(screen.getByTestId("error-state-message")).toHaveTextContent("503");
    fireEvent.click(screen.getByTestId("error-state-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("hides retry button when onRetry is omitted", () => {
    render(<ErrorState message="No RPC available." />);
    expect(screen.queryByTestId("error-state-retry")).toBeNull();
  });
});

describe("LoadingSkeleton", () => {
  it("renders the requested number of rows", () => {
    const { container } = render(<LoadingSkeleton rows={5} />);
    const rows = container.querySelectorAll(".animate-pulse");
    expect(rows.length).toBe(5);
  });

  it("defaults to 3 rows", () => {
    const { container } = render(<LoadingSkeleton />);
    const rows = container.querySelectorAll(".animate-pulse");
    expect(rows.length).toBe(3);
  });

  it("exposes role=status + aria-label for assistive tech", () => {
    render(<LoadingSkeleton testId="my-skel" />);
    const node = screen.getByTestId("my-skel");
    expect(node.getAttribute("role")).toBe("status");
    expect(node.getAttribute("aria-label")).toBe("Loading");
  });
});
