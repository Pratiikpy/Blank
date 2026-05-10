import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useContacts. Pin the offline-first contract: local
// storage is the source of truth, Supabase merge is "local wins" so
// offline edits aren't clobbered, AND local-only contacts get pushed
// back to Supabase (the easy-to-regress union step).

const fetchContactsMock = vi.hoisted(() => vi.fn());
const upsertContactMock = vi.hoisted(() => vi.fn());
const deleteContactMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());

vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));

vi.mock("@/lib/supabase", () => ({
  fetchContacts: fetchContactsMock,
  upsertContact: upsertContactMock,
  deleteContact: deleteContactMock,
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), error: vi.fn() },
}));

import { useContacts } from "./useContacts";
import { STORAGE_KEYS } from "@/lib/storage";

const ALICE_OWNER = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";
const DAVE = "0x4444444444444444444444444444444444444444";

beforeEach(() => {
  localStorage.clear();
  fetchContactsMock.mockReset();
  upsertContactMock.mockReset();
  deleteContactMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ALICE_OWNER });
});

describe("useContacts (§15.x)", () => {
  it("returns an empty list when no address is connected", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    fetchContactsMock.mockResolvedValue([]);

    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.contacts).toEqual([]);
    expect(fetchContactsMock).not.toHaveBeenCalled();
  });

  it("loads contacts from localStorage on mount", async () => {
    const seeded = [{ address: BOB, nickname: "Bob" }];
    localStorage.setItem(STORAGE_KEYS.contacts(ALICE_OWNER), JSON.stringify(seeded));
    fetchContactsMock.mockResolvedValue([]);

    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.contacts).toEqual(seeded));
  });

  it("merges remote contacts that aren't already in local storage", async () => {
    const local = [{ address: BOB, nickname: "Bob (offline-edited)" }];
    localStorage.setItem(STORAGE_KEYS.contacts(ALICE_OWNER), JSON.stringify(local));
    fetchContactsMock.mockResolvedValue([
      { contact_address: BOB, nickname: "Bob from remote" },
      { contact_address: CAROL, nickname: "Carol" },
    ]);

    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.contacts.length).toBe(2));

    const byAddr = Object.fromEntries(
      result.current.contacts.map((c) => [c.address.toLowerCase(), c.nickname]),
    );
    // Local wins for Bob (offline edit preserved).
    expect(byAddr[BOB.toLowerCase()]).toBe("Bob (offline-edited)");
    // Remote-only contact (Carol) is added.
    expect(byAddr[CAROL.toLowerCase()]).toBe("Carol");
  });

  it("pushes local-only contacts to Supabase on load (union sync)", async () => {
    const local = [{ address: DAVE, nickname: "Dave (added offline)" }];
    localStorage.setItem(STORAGE_KEYS.contacts(ALICE_OWNER), JSON.stringify(local));
    fetchContactsMock.mockResolvedValue([
      { contact_address: CAROL, nickname: "Carol" },
    ]);
    upsertContactMock.mockResolvedValue(undefined);

    renderHook(() => useContacts());
    await waitFor(() => expect(upsertContactMock).toHaveBeenCalled());

    expect(upsertContactMock).toHaveBeenCalledWith({
      owner_address: ALICE_OWNER.toLowerCase(),
      contact_address: DAVE.toLowerCase(),
      nickname: "Dave (added offline)",
    });
  });

  it("addContact normalizes the address to lowercase + writes to localStorage + Supabase", async () => {
    fetchContactsMock.mockResolvedValue([]);
    upsertContactMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const MIXED_CASE_BOB = "0x2222222222222222222222222222222222222222".toUpperCase();
    await act(async () => {
      await result.current.addContact(MIXED_CASE_BOB, "Bob");
    });

    expect(result.current.contacts[0].address).toBe(MIXED_CASE_BOB.toLowerCase());

    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.contacts(ALICE_OWNER)) ?? "[]",
    );
    expect(stored[0].address).toBe(MIXED_CASE_BOB.toLowerCase());

    expect(upsertContactMock).toHaveBeenCalledWith({
      owner_address: ALICE_OWNER.toLowerCase(),
      contact_address: MIXED_CASE_BOB.toLowerCase(),
      nickname: "Bob",
    });
  });

  it("addContact for an existing address replaces (no duplicates)", async () => {
    fetchContactsMock.mockResolvedValue([]);
    upsertContactMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addContact(BOB, "Bob");
    });
    await act(async () => {
      await result.current.addContact(BOB, "Bob renamed");
    });

    expect(result.current.contacts.length).toBe(1);
    expect(result.current.contacts[0].nickname).toBe("Bob renamed");
  });

  it("removeContact strips the entry from local state + localStorage + Supabase", async () => {
    const local = [
      { address: BOB, nickname: "Bob" },
      { address: CAROL, nickname: "Carol" },
    ];
    localStorage.setItem(STORAGE_KEYS.contacts(ALICE_OWNER), JSON.stringify(local));
    fetchContactsMock.mockResolvedValue([]);
    deleteContactMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.contacts.length).toBe(2));

    await act(async () => {
      await result.current.removeContact(BOB);
    });

    expect(result.current.contacts.length).toBe(1);
    expect(result.current.contacts[0].address).toBe(CAROL);

    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.contacts(ALICE_OWNER)) ?? "[]",
    );
    expect(stored.length).toBe(1);

    expect(deleteContactMock).toHaveBeenCalledWith(
      ALICE_OWNER.toLowerCase(),
      BOB.toLowerCase(),
    );
  });

  it("addContact still updates local state when Supabase upsert rejects", async () => {
    fetchContactsMock.mockResolvedValue([]);
    upsertContactMock.mockRejectedValue(new Error("supabase down"));

    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addContact(BOB, "Bob");
    });

    // Local-first: the row appears in state even when remote sync fails.
    expect(result.current.contacts.length).toBe(1);
    expect(result.current.contacts[0].nickname).toBe("Bob");
  });
});
