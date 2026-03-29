import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";

export function FHEBadge({ className }: { className?: string }) {
  return (
    <span className={cn("badge-fhe", className)}>
      <Lock size={12} strokeWidth={2.5} />
      FHE Encrypted
    </span>
  );
}
