import { useState, useCallback, useEffect } from "react";
import { useEffectiveAddress } from "./useEffectiveAddress";
import {
  fetchContacts,
  upsertContact,
  deleteContact,
} from "@/lib/supabase";
import { STORAGE_KEYS, getStoredJson, setStoredJson } from "@/lib/storage";
import toast from "react-hot-toast";

interface Contact {
  address: string;
  nickname: string;
}

/**
 * Manages contacts with localStorage primary + Supabase sync.
 * Contacts are always available offline via localStorage.
 * When Supabase is connected, they sync both ways.
 */
export function useContacts() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Load from localStorage immediately
  const loadLocal = useCallback((): Contact[] => {
    if (!address) return [];
    return getStoredJson<Contact[]>(STORAGE_KEYS.contacts(address), []);
  }, [address]);

  // Save to localStorage
  const saveLocal = useCallback(
    (items: Contact[]) => {
      if (!address) return;
      setStoredJson(STORAGE_KEYS.contacts(address), items);
    },
    [address]
  );

  // Load contacts (localStorage first, then Supabase merge)
  const load = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);

    // Start with local
    const local = loadLocal();
    setContacts(local);

    // Try Supabase — merge using "local wins, union both" strategy
    const remote = await fetchContacts(address.toLowerCase());
    if (remote.length > 0) {
      // Start with all local contacts (they may have been edited offline)
      const merged = new Map<string, Contact>();
      for (const c of local) merged.set(c.address.toLowerCase(), c);

      // Add remote contacts only if they don't already exist locally.
      // Local contacts are kept as-is (preserving offline edits to nicknames).
      for (const c of remote) {
        const key = c.contact_address.toLowerCase();
        if (!merged.has(key)) {
          merged.set(key, { address: c.contact_address, nickname: c.nickname });
        }
      }

      const result = Array.from(merged.values());
      setContacts(result);
      saveLocal(result);

      // Push any local-only contacts to Supabase so they aren't lost
      const remoteKeys = new Set(remote.map((c) => c.contact_address.toLowerCase()));
      for (const c of local) {
        if (!remoteKeys.has(c.address.toLowerCase())) {
          upsertContact({
            owner_address: address.toLowerCase(),
            contact_address: c.address.toLowerCase(),
            nickname: c.nickname,
          }).catch(() => {
            // Non-critical — will retry on next load
          });
        }
      }
    }

    setIsLoading(false);
  }, [address, loadLocal, saveLocal]);

  useEffect(() => {
    load();
    // Explicit `address` dependency — relying on `load` alone is brittle
    // because useCallback identity-change depends on address transitively.
  }, [load, address]);

  // Add or update a contact
  const addContact = useCallback(
    async (contactAddress: string, nickname: string) => {
      if (!address) return;

      const normalized = contactAddress.toLowerCase();
      const newContact: Contact = { address: normalized, nickname };

      // Update local state
      setContacts((prev) => {
        const filtered = prev.filter((c) => c.address.toLowerCase() !== normalized);
        const updated = [...filtered, newContact];
        saveLocal(updated);
        return updated;
      });

      // Sync to Supabase
      try {
        await upsertContact({
          owner_address: address.toLowerCase(),
          contact_address: normalized,
          nickname,
        });
      } catch {
        console.warn("Contact saved locally but remote sync failed");
      }

      toast.success(`Contact "${nickname}" saved`);
    },
    [address, saveLocal]
  );

  // Remove a contact
  const removeContact = useCallback(
    async (contactAddress: string) => {
      if (!address) return;

      const normalized = contactAddress.toLowerCase();

      setContacts((prev) => {
        const updated = prev.filter((c) => c.address.toLowerCase() !== normalized);
        saveLocal(updated);
        return updated;
      });

      try {
        await deleteContact(address.toLowerCase(), normalized);
      } catch {
        console.warn("Contact removed locally but remote sync failed");
      }
      toast.success("Contact removed");
    },
    [address, saveLocal]
  );

  return {
    contacts,
    isLoading,
    addContact,
    removeContact,
    reload: load,
  };
}
