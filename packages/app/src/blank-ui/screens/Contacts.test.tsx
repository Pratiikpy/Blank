import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for Contacts screen. Pins the audit Top-28 #16 fix:
// the ref-based double-submit guard prevents two rapid Enters from
// both creating a contact (setIsAdding state update is async; the
// ref flips synchronously). Also pins form validation + search +
// confirm-then-remove flow.

const useContactsMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useContacts", () => ({
  useContacts: useContactsMock,
}));

vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

import Contacts from "./Contacts";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const addContactMock = vi.fn();
const removeContactMock = vi.fn();

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

beforeEach(() => {
  useContactsMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  addContactMock.mockReset();
  removeContactMock.mockReset();
  useContactsMock.mockReturnValue({
    contacts: [],
    addContact: addContactMock,
    removeContact: removeContactMock,
  });
  addContactMock.mockResolvedValue(undefined);
});

describe("Contacts — page chrome (§15.x)", () => {
  it("renders 'Contacts' heading + subtitle", () => {
    const { container } = withRouter(<Contacts />);
    expect(container.textContent).toContain("Contacts");
    expect(container.textContent).toContain("Your address book");
  });

  it("renders the back button + Add button", () => {
    const { getByLabelText } = withRouter(<Contacts />);
    expect(getByLabelText("Go back")).toBeDefined();
    expect(getByLabelText("Add contact")).toBeDefined();
  });

  it("Add form is hidden by default", () => {
    const { container } = withRouter(<Contacts />);
    expect(container.querySelector("input[placeholder='Nickname']")).toBeNull();
  });

  it("clicking 'Add' button toggles the form open", () => {
    const { getByLabelText, container } = withRouter(<Contacts />);
    fireEvent.click(getByLabelText("Add contact"));
    expect(container.querySelector("input[placeholder='Nickname']")).not.toBeNull();
  });
});

describe("Contacts — form validation (§15.x)", () => {
  function openForm(getByLabelText: (l: string) => HTMLElement) {
    fireEvent.click(getByLabelText("Add contact"));
  }

  it("empty nickname → 'Enter a name' toast", () => {
    const { getByLabelText, getByText } = withRouter(<Contacts />);
    openForm(getByLabelText);
    fireEvent.click(getByText("Save Contact"));
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a name");
    expect(addContactMock).not.toHaveBeenCalled();
  });

  it("name present but address empty → 'Enter a wallet address' toast", () => {
    const { getByLabelText, getByText, container } = withRouter(<Contacts />);
    openForm(getByLabelText);
    const nameInput = container.querySelector("input[placeholder='Nickname']") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Alice" } });
    fireEvent.click(getByText("Save Contact"));
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a wallet address");
  });

  it("invalid hex address → 'Invalid Ethereum address' toast", () => {
    const { getByLabelText, getByText, container } = withRouter(<Contacts />);
    openForm(getByLabelText);
    const nameInput = container.querySelector("input[placeholder='Nickname']") as HTMLInputElement;
    const addrInput = container.querySelector("input[placeholder='0x... wallet address']") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Alice" } });
    fireEvent.change(addrInput, { target: { value: "garbage-not-an-address" } });
    fireEvent.click(getByText("Save Contact"));
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid Ethereum address");
    expect(addContactMock).not.toHaveBeenCalled();
  });

  it("valid input calls addContact(address, name)", async () => {
    const { getByLabelText, getByText, container } = withRouter(<Contacts />);
    openForm(getByLabelText);
    const nameInput = container.querySelector("input[placeholder='Nickname']") as HTMLInputElement;
    const addrInput = container.querySelector("input[placeholder='0x... wallet address']") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Alice" } });
    fireEvent.change(addrInput, { target: { value: ALICE } });

    await act(async () => {
      fireEvent.click(getByText("Save Contact"));
      await Promise.resolve();
    });
    expect(addContactMock).toHaveBeenCalledWith(ALICE, "Alice");
  });

  it("trims whitespace from name + address before validation/submit", async () => {
    const { getByLabelText, getByText, container } = withRouter(<Contacts />);
    openForm(getByLabelText);
    const nameInput = container.querySelector("input[placeholder='Nickname']") as HTMLInputElement;
    const addrInput = container.querySelector("input[placeholder='0x... wallet address']") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "  Alice  " } });
    fireEvent.change(addrInput, { target: { value: `  ${ALICE}  ` } });

    await act(async () => {
      fireEvent.click(getByText("Save Contact"));
      await Promise.resolve();
    });
    expect(addContactMock).toHaveBeenCalledWith(ALICE, "Alice");
  });
});

describe("Contacts — audit Top-28 #16 double-submit guard (§15.x)", () => {
  it("CRITICAL: rapid double-click does NOT call addContact twice (synchronous ref guard)", async () => {
    let resolveAdd: () => void = () => {};
    addContactMock.mockImplementation(
      () => new Promise<void>((r) => { resolveAdd = r; }),
    );

    const { getByLabelText, getByText, container } = withRouter(<Contacts />);
    fireEvent.click(getByLabelText("Add contact"));
    const nameInput = container.querySelector("input[placeholder='Nickname']") as HTMLInputElement;
    const addrInput = container.querySelector("input[placeholder='0x... wallet address']") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Alice" } });
    fireEvent.change(addrInput, { target: { value: ALICE } });

    // Grab the button BEFORE the first click — its text changes to
    // "Saving…" mid-flight so getByText("Save Contact") would fail.
    const saveBtn = getByText("Save Contact");

    // Fire two clicks back-to-back BEFORE the addContact promise resolves.
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn);

    expect(addContactMock).toHaveBeenCalledTimes(1);

    // Cleanup so the test doesn't hang.
    resolveAdd();
    await act(async () => { await Promise.resolve(); });
  });

  it("Enter key on nickname input submits when valid", async () => {
    const { getByLabelText, container } = withRouter(<Contacts />);
    fireEvent.click(getByLabelText("Add contact"));
    const nameInput = container.querySelector("input[placeholder='Nickname']") as HTMLInputElement;
    const addrInput = container.querySelector("input[placeholder='0x... wallet address']") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Alice" } });
    fireEvent.change(addrInput, { target: { value: ALICE } });

    await act(async () => {
      fireEvent.keyDown(nameInput, { key: "Enter" });
      await Promise.resolve();
    });
    expect(addContactMock).toHaveBeenCalledWith(ALICE, "Alice");
  });

  it("button is disabled + shows 'Saving…' label while addContact is pending", async () => {
    let resolveAdd: () => void = () => {};
    addContactMock.mockImplementation(
      () => new Promise<void>((r) => { resolveAdd = r; }),
    );

    const { getByLabelText, getByText, container } = withRouter(<Contacts />);
    fireEvent.click(getByLabelText("Add contact"));
    const nameInput = container.querySelector("input[placeholder='Nickname']") as HTMLInputElement;
    const addrInput = container.querySelector("input[placeholder='0x... wallet address']") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Alice" } });
    fireEvent.change(addrInput, { target: { value: ALICE } });

    await act(async () => {
      fireEvent.click(getByText("Save Contact"));
      await Promise.resolve();
    });

    // While pending, button reads "Saving…" + disabled.
    const saving = container.querySelector("button[disabled]")! as HTMLButtonElement;
    expect(saving.textContent).toContain("Saving");

    resolveAdd();
    await act(async () => { await Promise.resolve(); });
  });
});

describe("Contacts — search filter (§15.x)", () => {
  beforeEach(() => {
    useContactsMock.mockReturnValue({
      contacts: [
        { address: ALICE, nickname: "Alice" },
        { address: BOB, nickname: "Bob" },
      ],
      addContact: addContactMock,
      removeContact: removeContactMock,
    });
  });

  it("renders all contacts when search is empty", () => {
    const { container } = withRouter(<Contacts />);
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).toContain("Bob");
  });

  it("filters by nickname substring (case-insensitive)", () => {
    const { container, getByPlaceholderText } = withRouter(<Contacts />);
    const search = getByPlaceholderText("Search contacts...");
    fireEvent.change(search, { target: { value: "alic" } });

    expect(container.textContent).toContain("Alice");
    expect(container.textContent).not.toContain("Bob");
  });

  it("filters by address substring (case-insensitive — search is lowercased)", () => {
    const { container, getByPlaceholderText } = withRouter(<Contacts />);
    const search = getByPlaceholderText("Search contacts...");
    // Source: `c.address.includes(search.toLowerCase())`.
    fireEvent.change(search, { target: { value: ALICE.slice(2, 10) } });

    expect(container.textContent).toContain("Alice");
  });

  it("no-match search renders the empty state", () => {
    const { container, getByPlaceholderText } = withRouter(<Contacts />);
    const search = getByPlaceholderText("Search contacts...");
    fireEvent.change(search, { target: { value: "nobody-matches-this" } });
    expect(container.textContent).toContain("No contacts yet");
  });
});

describe("Contacts — remove flow (§15.x)", () => {
  beforeEach(() => {
    useContactsMock.mockReturnValue({
      contacts: [{ address: ALICE, nickname: "Alice" }],
      addContact: addContactMock,
      removeContact: removeContactMock,
    });
  });

  it("confirms before calling removeContact (window.confirm gate)", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { getByLabelText } = withRouter(<Contacts />);
    fireEvent.click(getByLabelText("Remove Alice"));
    expect(confirmSpy).toHaveBeenCalledWith("Remove this contact?");
    expect(removeContactMock).toHaveBeenCalledWith(ALICE);
    confirmSpy.mockRestore();
  });

  it("does NOT remove when confirm returns false", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { getByLabelText } = withRouter(<Contacts />);
    fireEvent.click(getByLabelText("Remove Alice"));
    expect(removeContactMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("renders avatar with first letter of nickname uppercased", () => {
    const { container } = withRouter(<Contacts />);
    // Look for the avatar div with "A" inside.
    const text = container.textContent ?? "";
    expect(text).toMatch(/A.*Alice/);
  });
});

describe("Contacts — empty state (§15.x)", () => {
  it("renders 'No contacts yet' + helpful body when zero contacts", () => {
    const { container } = withRouter(<Contacts />);
    expect(container.textContent).toContain("No contacts yet");
    expect(container.textContent).toContain("Save addresses with nicknames");
  });

  it("empty-state 'Add a contact' CTA opens the form", async () => {
    const { container, getByText } = withRouter(<Contacts />);
    fireEvent.click(getByText("Add a contact"));
    await waitFor(() => {
      expect(container.querySelector("input[placeholder='Nickname']")).not.toBeNull();
    });
  });
});
