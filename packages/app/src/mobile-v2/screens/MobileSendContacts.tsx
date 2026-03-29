import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Search,
  ChevronRight,
  Lock,
  UserPlus,
} from "lucide-react";
import { useContacts } from "@/hooks/useContacts";
import { useActivityFeed } from "@/hooks/useActivityFeed";

// ═══════════════════════════════════════════════════════════════════
//  DEMO DATA
// ═══════════════════════════════════════════════════════════════════

const DEMO_CONTACTS = [
  { name: "Jordan Park", handle: "@jordan.p", address: "0x1234567890abcdef1234567890abcdef12345678" },
  { name: "Sam Chen", handle: "@sam.c", address: "0x2345678901abcdef2345678901abcdef23456789" },
  { name: "Maya Patel", handle: "@maya.p", address: "0x3456789012abcdef3456789012abcdef34567890" },
  { name: "Alex Rivera", handle: "@alex.r", address: "0x4567890123abcdef4567890123abcdef45678901" },
  { name: "Taylor Kim", handle: "@taylor.k", address: "0x5678901234abcdef5678901234abcdef56789012" },
  { name: "Casey Liu", handle: "@casey.l", address: "0x6789012345abcdef6789012345abcdef67890123" },
];

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** Deterministic avatar initials from name or address. */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Deterministic hue from a string. */
function stringToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

interface DisplayContact {
  name: string;
  handle: string;
  address: string;
}

// ═══════════════════════════════════════════════════════════════════
//  COMPONENT
// ═══════════════════════════════════════════════════════════════════

export function MobileSendContacts() {
  const navigate = useNavigate();
  const { contacts } = useContacts();
  const { activities } = useActivityFeed();
  const [search, setSearch] = useState("");

  // Build contact list: real contacts, fallback to activity addresses, then demo
  const displayContacts: DisplayContact[] = useMemo(() => {
    if (contacts.length > 0) {
      return contacts.map((c) => ({
        name: c.nickname || shortenAddress(c.address),
        handle: c.nickname ? `@${c.nickname.toLowerCase().replace(/\s+/g, ".")}` : shortenAddress(c.address),
        address: c.address,
      }));
    }

    // Try activity addresses
    const seen = new Set<string>();
    const fromActivities: DisplayContact[] = [];
    for (const a of activities) {
      const addr = a.user_to.toLowerCase();
      if (!seen.has(addr)) {
        seen.add(addr);
        fromActivities.push({
          name: shortenAddress(a.user_to),
          handle: shortenAddress(a.user_to),
          address: a.user_to,
        });
      }
      if (fromActivities.length >= 6) break;
    }

    if (fromActivities.length > 0) return fromActivities;
    return DEMO_CONTACTS;
  }, [contacts, activities]);

  // Filter by search
  const filtered = useMemo(() => {
    if (!search.trim()) return displayContacts;
    const q = search.toLowerCase();
    return displayContacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.handle.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q),
    );
  }, [displayContacts, search]);

  // Recent contacts (top 5 for horizontal scroll)
  const recentContacts = useMemo(() => displayContacts.slice(0, 5), [displayContacts]);

  const handleSelectContact = (contact: DisplayContact) => {
    navigate("/m/send/amount", {
      state: {
        name: contact.name,
        handle: contact.handle,
        address: contact.address,
      },
    });
  };

  return (
    <div style={{ padding: "0 16px", paddingBottom: 16 }}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="mobile-header" style={{ padding: "12px 0" }}>
        <button
          className="mobile-header-back"
          onClick={() => navigate("/m")}
          aria-label="Go back"
        >
          <ArrowLeft size={18} strokeWidth={2} color="var(--text-primary)" />
        </button>
        <div style={{ flex: 1 }}>
          <h1
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text-primary)",
              margin: 0,
              lineHeight: 1.3,
            }}
          >
            Send Money
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
            <Lock size={10} color="var(--primary)" />
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 500 }}>
              All amounts FHE encrypted
            </span>
          </div>
        </div>
      </header>

      {/* ── Search Bar ──────────────────────────────────────────────── */}
      <div
        className="mobile-card"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          marginTop: 8,
        }}
      >
        <Search size={18} color="var(--text-tertiary)" style={{ flexShrink: 0 }} />
        <input
          type="text"
          placeholder="Search name or handle..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 14,
            color: "var(--text-primary)",
            fontFamily: "inherit",
          }}
          aria-label="Search contacts"
        />
      </div>

      {/* ── Recent Contacts (horizontal scroll) ─────────────────────── */}
      {!search.trim() && recentContacts.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <span className="mobile-section-title" style={{ display: "block", marginBottom: 12 }}>
            Recent
          </span>
          <div
            style={{
              display: "flex",
              gap: 16,
              overflowX: "auto",
              paddingBottom: 4,
              WebkitOverflowScrolling: "touch",
              scrollbarWidth: "none",
            }}
          >
            {recentContacts.map((contact) => {
              const hue = stringToHue(contact.address);
              return (
                <button
                  key={contact.address}
                  onClick={() => handleSelectContact(contact)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    minWidth: 64,
                    WebkitTapHighlightColor: "transparent",
                  }}
                  aria-label={`Send to ${contact.name}`}
                >
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: "50%",
                      background: `linear-gradient(135deg, hsl(${hue}, 60%, 55%) 0%, hsl(${hue + 30}, 50%, 65%) 100%)`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "white",
                      fontWeight: 700,
                      fontSize: 15,
                    }}
                  >
                    {getInitials(contact.name)}
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: "var(--text-secondary)",
                      maxWidth: 64,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {contact.name.split(" ")[0]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Contact List ────────────────────────────────────────────── */}
      <div style={{ marginTop: 20 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <span className="mobile-section-title">
            {search.trim() ? "Results" : "All Contacts"}
          </span>
          {!search.trim() && (
            <button
              className="mobile-btn-ghost"
              style={{ padding: "6px 10px", fontSize: 12 }}
              aria-label="Add new contact"
            >
              <UserPlus size={14} />
              Add
            </button>
          )}
        </div>

        <div className="mobile-card" style={{ padding: "4px 16px" }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  margin: "0 0 4px",
                }}
              >
                No contacts found
              </p>
              <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: 0 }}>
                Try a different search term
              </p>
            </div>
          ) : (
            <div role="list" aria-label="Contact list">
              {filtered.map((contact) => {
                const hue = stringToHue(contact.address);
                return (
                  <button
                    key={contact.address}
                    onClick={() => handleSelectContact(contact)}
                    className="mobile-tx-item"
                    role="listitem"
                    style={{
                      width: "100%",
                      background: "none",
                      border: "none",
                      textAlign: "left",
                      cursor: "pointer",
                      WebkitTapHighlightColor: "transparent",
                    }}
                    aria-label={`Send to ${contact.name}`}
                  >
                    {/* Avatar */}
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: "50%",
                        background: `linear-gradient(135deg, hsl(${hue}, 60%, 55%) 0%, hsl(${hue + 30}, 50%, 65%) 100%)`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "white",
                        fontWeight: 700,
                        fontSize: 14,
                        flexShrink: 0,
                      }}
                    >
                      {getInitials(contact.name)}
                    </div>

                    {/* Name + handle */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: "var(--text-primary)",
                          margin: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {contact.name}
                      </p>
                      <p
                        style={{
                          fontSize: 12,
                          color: "var(--text-tertiary)",
                          margin: "2px 0 0",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {contact.handle}
                      </p>
                    </div>

                    {/* Chevron */}
                    <ChevronRight size={18} color="var(--text-tertiary)" style={{ flexShrink: 0 }} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MobileSendContacts;
