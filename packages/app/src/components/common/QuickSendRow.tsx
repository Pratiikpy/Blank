import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { GradientAvatar } from "./GradientAvatar";

// ─── Types ──────────────────────────────────────────────────────────

interface Contact {
  address: string;
  name?: string;
  lastActivity?: string;
}

interface QuickSendRowProps {
  contacts: Contact[];
  onSelect: (address: string) => void;
  /** Called when the user taps the "+" button to add a new contact */
  onAddContact?: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

function getDisplayName(contact: Contact): string {
  if (contact.name && contact.name.trim().length > 0) {
    return contact.name;
  }
  return truncateAddress(contact.address);
}

// ─── Spring for the tap scale ───────────────────────────────────────

const tapSpring = {
  type: "spring" as const,
  stiffness: 500,
  damping: 20,
};

// ─── Empty State ────────────────────────────────────────────────────

function EmptyState({
  onSubmit,
}: {
  onSubmit: (address: string) => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    if (trimmed.length > 0) {
      onSubmit(trimmed);
      setInputValue("");
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-center gap-3 w-full"
    >
      <div className="input-glow group relative flex-1">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          placeholder="Enter address or name..."
          className={cn(
            "w-full h-11 pl-4 pr-12 text-sm text-white placeholder:text-neutral-600",
            "bg-gradient-to-b from-white/[0.04] to-white/[0.02]",
            "border border-white/[0.08] rounded-xl",
            "ring-1 ring-inset ring-white/[0.04]",
            "transition-all duration-200 ease-out",
            "hover:border-white/[0.14]",
            "focus:border-accent/40 focus:ring-accent/15 focus:outline-none",
            "focus:shadow-[0_0_0_1px_rgba(16,185,129,0.1),0_0_16px_rgba(16,185,129,0.06)]"
          )}
          aria-label="Recipient address"
        />
        <button
          type="button"
          onClick={handleSubmit}
          className={cn(
            "absolute right-2 top-1/2 -translate-y-1/2",
            "w-7 h-7 rounded-lg flex items-center justify-center",
            "bg-accent/10 text-accent hover:bg-accent/20",
            "transition-colors duration-150"
          )}
          aria-label="Send to this address"
        >
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </motion.div>
  );
}

// ─── Contact Item ───────────────────────────────────────────────────

function ContactItem({
  contact,
  onSelect,
  index,
}: {
  contact: Contact;
  onSelect: (address: string) => void;
  index: number;
}) {
  const displayName = getDisplayName(contact);

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 12, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.35,
        delay: index * 0.05,
        ease: [0.25, 0.46, 0.45, 0.94],
      }}
      whileTap={{ scale: 0.92, transition: tapSpring }}
      onClick={() => onSelect(contact.address)}
      className={cn(
        "flex flex-col items-center gap-1.5 min-w-[72px] snap-start",
        "rounded-2xl py-2.5 px-2",
        "transition-colors duration-150",
        "hover:bg-white/[0.04]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-void"
      )}
      aria-label={`Send to ${contact.name || contact.address}`}
    >
      <GradientAvatar
        address={contact.address}
        name={contact.name}
        size="lg"
      />
      <span className="text-caption font-medium text-text-secondary truncate max-w-[72px] text-center">
        {displayName}
      </span>
      {contact.lastActivity && (
        <span className="text-[10px] text-text-muted leading-none">
          {contact.lastActivity}
        </span>
      )}
    </motion.button>
  );
}

// ─── Add Contact Button ─────────────────────────────────────────────

function AddContactButton({
  onClick,
  index,
}: {
  onClick?: () => void;
  index: number;
}) {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 12, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.35,
        delay: index * 0.05,
        ease: [0.25, 0.46, 0.45, 0.94],
      }}
      whileTap={{ scale: 0.92, transition: tapSpring }}
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1.5 min-w-[72px] snap-start",
        "rounded-2xl py-2.5 px-2",
        "transition-colors duration-150",
        "hover:bg-white/[0.04]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-void"
      )}
      aria-label="Add new contact"
    >
      {/* Dashed circle with plus icon */}
      <div
        className={cn(
          "w-16 h-16 rounded-full flex items-center justify-center shrink-0",
          "border-2 border-dashed border-white/[0.12]",
          "bg-white/[0.03]",
          "transition-colors duration-200",
          "group-hover:border-white/[0.20] group-hover:bg-white/[0.05]"
        )}
      >
        <Plus className="w-5 h-5 text-text-tertiary" />
      </div>
      <span className="text-caption font-medium text-text-tertiary">
        Add
      </span>
    </motion.button>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function QuickSendRow({
  contacts,
  onSelect,
  onAddContact,
}: QuickSendRowProps) {
  const hasContacts = contacts.length > 0;

  return (
    <div className="w-full">
      {/* Section label */}
      <p className="text-label font-semibold text-text-tertiary uppercase mb-3">
        {hasContacts ? "Send again" : "Send to anyone"}
      </p>

      <AnimatePresence mode="wait">
        {hasContacts ? (
          <motion.div
            key="contacts-row"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "flex gap-1 overflow-x-auto snap-x snap-mandatory",
              "pb-2 -mb-2",
              // Hide scrollbar across browsers
              "scrollbar-hide",
              "[&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
            )}
          >
            {contacts.map((contact, i) => (
              <ContactItem
                key={contact.address}
                contact={contact}
                onSelect={onSelect}
                index={i}
              />
            ))}
            <AddContactButton
              onClick={onAddContact}
              index={contacts.length}
            />
          </motion.div>
        ) : (
          <EmptyState key="empty-state" onSubmit={onSelect} />
        )}
      </AnimatePresence>
    </div>
  );
}
