import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { PillTabs } from "./PillTabs";

const TABS = [
  { id: "send", label: "Send" },
  { id: "receive", label: "Receive" },
  { id: "history", label: "History" },
];

describe("PillTabs (§15.x)", () => {
  it("renders all tab labels", () => {
    const { getByText } = render(
      <PillTabs tabs={TABS} activeTab="send" onTabChange={() => {}} />,
    );
    expect(getByText("Send")).toBeDefined();
    expect(getByText("Receive")).toBeDefined();
    expect(getByText("History")).toBeDefined();
  });

  it("marks the active tab with aria-selected=true and others false", () => {
    const { getAllByRole } = render(
      <PillTabs tabs={TABS} activeTab="receive" onTabChange={() => {}} />,
    );
    const tabs = getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute("aria-selected")).toBe("false"); // Send
    expect(tabs[1].getAttribute("aria-selected")).toBe("true"); // Receive
    expect(tabs[2].getAttribute("aria-selected")).toBe("false"); // History
  });

  it("container has role=tablist for screen readers", () => {
    const { getByRole } = render(
      <PillTabs tabs={TABS} activeTab="send" onTabChange={() => {}} />,
    );
    expect(getByRole("tablist")).toBeDefined();
  });

  it("calls onTabChange with the clicked tab id", () => {
    const onTabChange = vi.fn();
    const { getByText } = render(
      <PillTabs tabs={TABS} activeTab="send" onTabChange={onTabChange} />,
    );
    fireEvent.click(getByText("Receive"));
    expect(onTabChange).toHaveBeenCalledWith("receive");
  });

  it("clicking the active tab still calls onTabChange (caller decides what to do)", () => {
    const onTabChange = vi.fn();
    const { getByText } = render(
      <PillTabs tabs={TABS} activeTab="send" onTabChange={onTabChange} />,
    );
    fireEvent.click(getByText("Send"));
    expect(onTabChange).toHaveBeenCalledWith("send");
  });

  it("renders badge count when tab.badge > 0", () => {
    const tabs = [
      { id: "send", label: "Send" },
      { id: "requests", label: "Requests", badge: 3 },
    ];
    const { getByText } = render(
      <PillTabs tabs={tabs} activeTab="send" onTabChange={() => {}} />,
    );
    expect(getByText("3")).toBeDefined();
  });

  it("does NOT render badge when tab.badge is 0 or undefined", () => {
    const tabs = [
      { id: "send", label: "Send", badge: 0 },
      { id: "history", label: "History" },
    ];
    const { container } = render(
      <PillTabs tabs={tabs} activeTab="send" onTabChange={() => {}} />,
    );
    // The badge text would be "0" if rendered; we don't expect it.
    expect(container.textContent).not.toMatch(/\b0\b/);
  });

  it("caps badge display at '99+' for counts > 99", () => {
    const tabs = [{ id: "x", label: "X", badge: 250 }];
    const { getByText, queryByText } = render(
      <PillTabs tabs={tabs} activeTab="x" onTabChange={() => {}} />,
    );
    expect(getByText("99+")).toBeDefined();
    expect(queryByText("250")).toBeNull();
  });

  it("renders 99 verbatim (boundary)", () => {
    const tabs = [{ id: "x", label: "X", badge: 99 }];
    const { getByText, queryByText } = render(
      <PillTabs tabs={tabs} activeTab="x" onTabChange={() => {}} />,
    );
    expect(getByText("99")).toBeDefined();
    expect(queryByText("99+")).toBeNull();
  });
});
