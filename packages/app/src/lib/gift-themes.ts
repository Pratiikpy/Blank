// Gift themes — shared across Gifts.tsx (create flow + inbox display) and
// any future surfaces (claim deep-link page, notifications, PDF receipts).
//
// The theme an ID is stored on-chain via GiftMoney; we *also* prefix the
// human description with `<ThemeName>:` (e.g. "Birthday: Happy bday!") so
// the recipient can see the theme intent even without re-decoding the
// theme ID. `parseThemeFromDescription` recovers the theme by name match.

import { Gift, Heart, PartyPopper, Sparkles, type LucideIcon } from "lucide-react";

export interface GiftTheme {
  id: number;
  name: string;
  icon: LucideIcon;
  /** Tailwind text-color class for icon + accents. */
  color: string;
  /** Tailwind bg-color class for the icon halo / card surface. */
  bgColor: string;
  /** Tailwind border-color class for the themed card. */
  borderColor: string;
  /** One-line claim-screen tagline. */
  tagline: string;
}

export const GIFT_THEMES: GiftTheme[] = [
  {
    id: 1,
    name: "Birthday",
    icon: PartyPopper,
    color: "text-pink-600",
    bgColor: "bg-pink-50",
    borderColor: "border-pink-100",
    tagline: "Happy birthday. Claim your gift.",
  },
  {
    id: 2,
    name: "Celebration",
    icon: Sparkles,
    color: "text-amber-600",
    bgColor: "bg-amber-50",
    borderColor: "border-amber-100",
    tagline: "A little something to celebrate",
  },
  {
    id: 3,
    name: "Love",
    icon: Heart,
    color: "text-red-600",
    bgColor: "bg-red-50",
    borderColor: "border-red-100",
    tagline: "Sent with love",
  },
  {
    id: 4,
    name: "Thank You",
    icon: Gift,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-100",
    tagline: "Thank you. Please accept this.",
  },
];

export const DEFAULT_THEME: GiftTheme = GIFT_THEMES[3]; // "Thank You" — neutral fallback.

export function findThemeById(id: number | null | undefined): GiftTheme {
  if (id == null) return DEFAULT_THEME;
  return GIFT_THEMES.find((t) => t.id === id) ?? DEFAULT_THEME;
}

/** Recover the theme from a gift description like "Birthday: Happy bday!".
 *  Falls back to the default theme when no name prefix is recognized. */
export function parseThemeFromDescription(desc: string | null | undefined): GiftTheme {
  if (!desc) return DEFAULT_THEME;
  const stripped = desc.replace(/^\[envelope:\d+\]\s*/, "");
  const match = stripped.match(/^([A-Za-z ]+?):\s/);
  if (!match) return DEFAULT_THEME;
  const name = match[1].trim().toLowerCase();
  return (
    GIFT_THEMES.find((t) => t.name.toLowerCase() === name) ?? DEFAULT_THEME
  );
}
