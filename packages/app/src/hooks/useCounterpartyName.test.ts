import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("./useContacts", () => ({
  useContacts: vi.fn(),
}));
vi.mock("./useAddressResolver", () => ({
  useLookupName: vi.fn(),
}));

import { useCounterpartyName } from "./useCounterpartyName";
import { useContacts } from "./useContacts";
import { useLookupName } from "./useAddressResolver";

const useContactsMock = useContacts as unknown as ReturnType<typeof vi.fn>;
const useLookupNameMock = useLookupName as unknown as ReturnType<typeof vi.fn>;

const ALICE = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
  useContactsMock.mockReset();
  useLookupNameMock.mockReset();
});

describe("useCounterpartyName (§15.x)", () => {
  it("returns empty + hex source for null/undefined address", () => {
    useContactsMock.mockReturnValue({ contacts: [] });
    useLookupNameMock.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useCounterpartyName(null));
    expect(result.current).toEqual({ label: "", source: "hex" });
  });

  it("contact nickname wins over ENS + truncated hex", () => {
    useContactsMock.mockReturnValue({
      contacts: [{ address: ALICE, nickname: "Alice from work" }],
    });
    useLookupNameMock.mockReturnValue({ data: "alice.eth" });

    const { result } = renderHook(() => useCounterpartyName(ALICE));
    expect(result.current.source).toBe("contact");
    expect(result.current.label).toBe("Alice from work");
  });

  it("ENS wins over truncated hex when no contact match", () => {
    useContactsMock.mockReturnValue({ contacts: [] });
    useLookupNameMock.mockReturnValue({ data: "alice.eth" });

    const { result } = renderHook(() => useCounterpartyName(ALICE));
    expect(result.current.source).toBe("ens");
    expect(result.current.label).toBe("alice.eth");
  });

  it("falls back to truncated hex when neither contact nor ENS resolves", () => {
    useContactsMock.mockReturnValue({ contacts: [] });
    useLookupNameMock.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useCounterpartyName(ALICE));
    expect(result.current.source).toBe("hex");
    // truncateAddress: 6-prefix + "..." + 4-suffix = "0xAaaa...aaaa"
    expect(result.current.label).toMatch(/^0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}$/);
  });

  it("matches contacts case-insensitively", () => {
    useContactsMock.mockReturnValue({
      contacts: [{ address: ALICE.toLowerCase(), nickname: "alice-lower" }],
    });
    useLookupNameMock.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useCounterpartyName(ALICE.toUpperCase()));
    expect(result.current.source).toBe("contact");
    expect(result.current.label).toBe("alice-lower");
  });

  it("ignores empty-string nickname (falls through to ENS / hex)", () => {
    useContactsMock.mockReturnValue({
      contacts: [{ address: ALICE, nickname: "" }],
    });
    useLookupNameMock.mockReturnValue({ data: "alice.eth" });

    const { result } = renderHook(() => useCounterpartyName(ALICE));
    expect(result.current.source).toBe("ens");
    expect(result.current.label).toBe("alice.eth");
  });
});
