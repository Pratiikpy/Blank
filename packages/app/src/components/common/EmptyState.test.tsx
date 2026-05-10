import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title + icon + body", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="No activity yet"
        body="Send your first private payment to see it here."
      />,
    );
    expect(screen.getByText("No activity yet")).toBeTruthy();
    expect(screen.getByText(/Send your first private payment/)).toBeTruthy();
  });

  it("fires the primary CTA onClick", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={Inbox}
        title="No invoices yet"
        cta={{ label: "Create invoice", onClick }}
      />,
    );
    fireEvent.click(screen.getByText("Create invoice"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders the secondary action below the primary", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="No groups"
        cta={{ label: "Create group", onClick: () => {} }}
        secondary={{ label: "Join existing", href: "/app/groups/join" }}
      />,
    );
    expect(screen.getByText("Create group")).toBeTruthy();
    const link = screen.getByText("Join existing");
    expect(link).toBeTruthy();
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/app/groups/join");
  });

  it("centered density uses min-h-vh wrapper", () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="Test" density="centered" />,
    );
    expect(container.querySelector(".min-h-\\[60vh\\]")).toBeTruthy();
  });

  it("renders cta as anchor when href is given", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="Bank"
        cta={{ label: "Open", href: "/app/dashboard" }}
      />,
    );
    const link = screen.getByText("Open");
    expect(link.tagName).toBe("A");
  });
});
