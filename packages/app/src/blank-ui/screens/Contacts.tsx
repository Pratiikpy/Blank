import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useContacts } from "@/hooks/useContacts";
import { ChevronLeft, Plus, Trash2, Search, User } from "lucide-react";
import toast from "react-hot-toast";

export default function Contacts() {
  const navigate = useNavigate();
  const { contacts, addContact, removeContact } = useContacts();
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const filtered = search
    ? contacts.filter(
        (c) =>
          c.nickname.toLowerCase().includes(search.toLowerCase()) ||
          c.address.includes(search.toLowerCase()),
      )
    : contacts;

  const handleAdd = async () => {
    if (!newName.trim() || !newAddress.trim()) { toast.error(!newName.trim() ? "Enter a name" : "Enter a wallet address"); return; }
    if (!/^0x[a-fA-F0-9]{40}$/.test(newAddress.trim())) {
      toast.error("Invalid Ethereum address");
      return;
    }
    await addContact(newAddress.trim(), newName.trim());
    setNewName("");
    setNewAddress("");
    setShowAdd(false);
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="w-11 h-11 rounded-full bg-white border border-black/5 flex items-center justify-center shadow-sm"
            aria-label="Go back"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="flex-1">
            <h1
              className="text-3xl font-semibold tracking-tight"
              style={{ fontFamily: "'Outfit', sans-serif" }}
            >
              Contacts
            </h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Your address book
            </p>
          </div>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="h-10 px-4 rounded-full bg-[#1D1D1F] text-white text-sm font-medium flex items-center gap-2"
            aria-label="Add contact"
          >
            <Plus size={16} /> Add
          </button>
        </div>

        {showAdd && (
          <div className="glass-card-static rounded-[2rem] p-6 mb-6 space-y-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nickname"
              className="h-12 w-full px-4 rounded-xl bg-white/60 border border-black/5 outline-none"
            />
            <input
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              placeholder="0x... wallet address"
              className="h-12 w-full px-4 rounded-xl bg-white/60 border border-black/5 outline-none font-mono text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={handleAdd}
                className="h-12 flex-1 rounded-xl bg-[#1D1D1F] text-white font-medium"
              >
                Save Contact
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className="h-12 px-6 rounded-xl bg-gray-100 text-gray-600 font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="relative mb-4">
          <Search
            size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contacts..."
            aria-label="Search contacts"
            className="h-12 w-full pl-11 pr-4 rounded-full bg-gray-100 border-none outline-none text-sm"
          />
        </div>

        <div className="glass-card-static rounded-[2rem] p-4">
          {filtered.length === 0 ? (
            <div className="py-12 text-center">
              <User size={32} className="mx-auto mb-3 text-gray-300" />
              <p className="text-[var(--text-secondary)]">No contacts yet</p>
              <p className="text-xs text-[var(--text-tertiary)] mt-1">
                Add contacts for quick payments
              </p>
            </div>
          ) : (
            filtered.map((c) => (
              <div
                key={c.address}
                className="flex items-center gap-3 p-4 rounded-2xl hover:bg-white/50 transition-all"
              >
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-400 to-blue-400 flex items-center justify-center text-white font-medium text-sm">
                  {c.nickname.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{c.nickname}</p>
                  <p className="text-xs font-mono text-[var(--text-tertiary)] truncate">
                    {c.address}
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (confirm("Remove this contact?")) removeContact(c.address);
                  }}
                  className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                  aria-label={`Remove ${c.nickname}`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
