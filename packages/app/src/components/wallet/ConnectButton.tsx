import { useAccount, useConnect, useDisconnect } from "wagmi";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, LogOut, ChevronDown } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export function ConnectButton() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (!isConnected) {
    return (
      <div className="relative" ref={menuRef}>
        <Button
          variant="primary"
          size="sm"
          icon={<Wallet className="w-3.5 h-3.5" />}
          onClick={() => setShowMenu(!showMenu)}
          loading={isPending}
          className="hover:shadow-[0_0_16px_rgba(255,255,255,0.1)]"
        >
          Connect
        </Button>

        <AnimatePresence>
          {showMenu && (
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 mt-2 w-56 glass-elevated p-2 space-y-1"
            >
              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  onClick={() => {
                    connect({ connector });
                    setShowMenu(false);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-neutral-300 hover:text-white hover:bg-glass-hover transition-colors"
                >
                  <Wallet className="w-4 h-4 text-accent" />
                  {connector.name}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {connectError && (
          <p className="text-xs text-red-400 mt-2 text-center">
            Connection failed. Please try again.
          </p>
        )}
      </div>
    );
  }

  const truncatedAddress = address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : "";

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setShowMenu(!showMenu)}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-full",
          "bg-glass-surface border border-glass-border",
          "hover:border-glass-border-hover",
          "hover:shadow-[0_0_20px_rgba(255,255,255,0.12)] hover:scale-105",
          "transition-all duration-300",
          "text-sm font-mono text-neutral-300"
        )}
      >
        <div className="w-2 h-2 rounded-full bg-accent animate-glow-pulse" style={{ boxShadow: "0 0 6px currentColor" }} />
        {truncatedAddress}
        <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showMenu && "rotate-180")} />
      </button>

      <AnimatePresence>
        {showMenu && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 mt-2 w-56 glass-elevated p-2"
          >
            <div className="px-3 py-2 text-xs text-neutral-500">
              {chain?.name || "Unknown Network"}
            </div>
            <div className="px-3 py-1 text-xs font-mono text-neutral-400 truncate">
              {address}
            </div>
            <div className="border-t border-glass-border my-1.5" />
            <button
              onClick={() => {
                disconnect();
                setShowMenu(false);
              }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Disconnect
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
