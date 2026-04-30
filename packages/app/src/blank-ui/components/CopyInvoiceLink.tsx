// "Copy invoice link" affordance. Used both in BusinessTools (next to
// each invoice in the vendor list) and on the InvoicePage (vendor view).
//
// Builds the canonical share link `<origin>/app/invoice/<chainId>/<id>`
// via `lib/invoice-links` and writes it to the clipboard. Shows a
// transient "Copied" state for ~2s.
import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import toast from "react-hot-toast";
import { buildInvoiceLink } from "@/lib/invoice-links";
import { cn } from "@/lib/cn";

interface Props {
  chainId: number;
  invoiceId: number | string;
  className?: string;
  /** "icon" = compact 36×36 icon button. "full" = "Copy link" pill. */
  variant?: "icon" | "full";
}

export function CopyInvoiceLink({ chainId, invoiceId, className, variant = "full" }: Props) {
  const [copied, setCopied] = useState(false);

  const onClick = useCallback(async () => {
    try {
      const url = buildInvoiceLink(chainId, invoiceId);
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Invoice link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't copy link");
    }
  }, [chainId, invoiceId]);

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={copied ? "Copied" : "Copy invoice link"}
        className={cn(
          "h-9 w-9 rounded-lg flex items-center justify-center bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-[var(--text-primary)] transition-colors",
          className,
        )}
      >
        {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-9 px-3 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-[var(--text-primary)] text-sm font-medium transition-colors flex items-center gap-2",
        className,
      )}
    >
      {copied ? (
        <>
          <Check size={14} className="text-emerald-600" />
          Copied
        </>
      ) : (
        <>
          <Copy size={14} />
          Copy link
        </>
      )}
    </button>
  );
}
