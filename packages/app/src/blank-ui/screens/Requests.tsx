import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { useNavigate } from "react-router-dom";
import { ArrowDownLeft, ArrowUpRight, ChevronLeft } from "lucide-react";
import { useRequestPayment } from "@/hooks/useRequestPayment";
import { fetchIncomingRequests, fetchOutgoingRequests, type PaymentRequestRow } from "@/lib/supabase";

export default function Requests() {
  const { address } = useAccount();
  const navigate = useNavigate();
  useRequestPayment(); // Hook mounted for realtime subscription
  const [tab, setTab] = useState<"incoming" | "outgoing">("incoming");
  const [incoming, setIncoming] = useState<PaymentRequestRow[]>([]);
  const [outgoing, setOutgoing] = useState<PaymentRequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    Promise.all([
      fetchIncomingRequests(address.toLowerCase()),
      fetchOutgoingRequests(address.toLowerCase()),
    ]).then(([inc, out]) => {
      setIncoming(inc);
      setOutgoing(out);
      setLoading(false);
    });
  }, [address]);

  const requests = tab === "incoming" ? incoming : outgoing;

  if (!address) return null;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-full bg-white border border-black/5 flex items-center justify-center shadow-sm">
            <ChevronLeft size={20} />
          </button>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight" style={{ fontFamily: "'Outfit', sans-serif" }}>Payment Requests</h1>
            <p className="text-sm text-[var(--text-secondary)]">Manage incoming and outgoing requests</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-3 mb-6">
          {(["incoming", "outgoing"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`h-12 px-6 rounded-full font-medium transition-all ${
                tab === t
                  ? "bg-[#1D1D1F] text-white"
                  : "bg-white/60 border border-black/5 text-[var(--text-secondary)] hover:bg-white"
              }`}
            >
              {t === "incoming" ? "Incoming" : "Outgoing"}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="glass-card-static rounded-[2rem] p-6 space-y-3">
          {loading ? (
            <div className="space-y-3">
              {[1,2,3].map(i => <div key={i} className="h-16 rounded-2xl bg-gray-100 animate-pulse" />)}
            </div>
          ) : requests.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[var(--text-secondary)]">No {tab} requests</p>
            </div>
          ) : (
            requests.map(req => (
              <div key={req.id} className="flex items-center justify-between p-4 rounded-2xl bg-white/50 border border-black/5 hover:bg-white/70 transition-all">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${tab === "incoming" ? "bg-amber-50 text-amber-600" : "bg-blue-50 text-blue-600"}`}>
                    {tab === "incoming" ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{tab === "incoming" ? `From ${req.to_address.slice(0,8)}...` : `To ${req.from_address.slice(0,8)}...`}</p>
                    <p className="text-xs text-[var(--text-tertiary)]">{req.note || "No note"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-1 rounded-full ${req.status === "pending" ? "bg-amber-50 text-amber-600" : req.status === "fulfilled" ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-500"}`}>
                    {req.status}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
