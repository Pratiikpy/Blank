# Design System — Blank (Encrypted Payment Super-App)

## Design Philosophy

Privacy = darkness. Encryption = glass you can't see through. Money = precision.

The app should feel like a **luxury vault** -- dark, elegant, precise. Not "hacker terminal" dark. Think Swiss private banking meets modern fintech.

---

## Color System

### Core Palette (Dark, Monochromatic + Dual Accent)

The palette uses **emerald** (money, trust, go) and **violet** (encryption, privacy, premium) as a deliberate pairing. Every element instantly communicates whether it is public or encrypted through color alone.

**Key principle:** On dark backgrounds, use the **-400 shade** as the primary interactive color, not -500. The -500 shade gets swallowed by darkness; -400 has enough luminance to read as vibrant.

```css
:root {
  /* ── Background Layers (5 shades for real depth) ──────────────── */
  /* Not pure black -- #09090b has just enough warmth to read as    */
  /* "intentional darkness" instead of "broken screen"               */
  --bg-void:      #09090b;      /* App root background (zinc-950) */
  --bg-base:      #0c0c0f;      /* Page background, behind cards */
  --bg-surface:   #131316;      /* Default card background (opaque) */
  --bg-elevated:  #1a1a1f;      /* Modals, popovers, expanded panels */
  --bg-inset:     #0f0f12;      /* Recessed areas inside cards (inputs, stat pills) */
  --bg-overlay:   rgba(0, 0, 0, 0.75);  /* Modal scrim */

  /* ── Glass Morphism (visible, not invisible) ──────────────────── */
  /* KEY FIX: surface up from 0.03 to 0.05 -- cards actually show   */
  --glass-surface:      rgba(255, 255, 255, 0.05);  /* Card fill */
  --glass-hover:        rgba(255, 255, 255, 0.08);  /* Card hover */
  --glass-active:       rgba(255, 255, 255, 0.10);  /* Pressed/active */
  --glass-strong:       rgba(255, 255, 255, 0.12);  /* Double-stacked glass */
  --glass-blur:         24px;

  /* ── Borders (4 levels of visibility) ─────────────────────────── */
  --border-subtle:      rgba(255, 255, 255, 0.06);  /* Dividers inside cards */
  --border-default:     rgba(255, 255, 255, 0.10);  /* Card borders (up from 0.08) */
  --border-hover:       rgba(255, 255, 255, 0.18);  /* Interactive hover */
  --border-accent:      rgba(52, 211, 153, 0.25);   /* Focused elements */

  /* ── Text Hierarchy (zinc, not neutral -- cooler undertone) ───── */
  --text-primary:   #f4f4f5;    /* zinc-100 -- 15.4:1 on surface (AAA) */
  --text-secondary: #a1a1aa;    /* zinc-400 -- 7.2:1 (AAA) */
  --text-tertiary:  #71717a;    /* zinc-500 -- 4.5:1 (AA) */
  --text-muted:     #52525b;    /* zinc-600 -- decorative/disabled only */
  --text-inverse:   #09090b;    /* Text on accent backgrounds */

  /* ── Accent -- Emerald (money/finance) ────────────────────────── */
  /* PRIMARY INTERACTIVE = #34d399 (emerald-400) on dark backgrounds */
  /* #10b981 (emerald-500) = secondary, pressed, success states      */
  --accent:         #34d399;    /* emerald-400 -- PRIMARY */
  --accent-light:   #6ee7b7;    /* emerald-300 -- highlights, links */
  --accent-dark:    #10b981;    /* emerald-500 -- pressed, secondary */
  --accent-glow:    rgba(52, 211, 153, 0.15);
  --accent-glow-strong: rgba(52, 211, 153, 0.30);

  /* ── Encrypted/Private -- Violet (first-class citizen) ────────── */
  --encrypted:      #a78bfa;    /* violet-400 -- PRIMARY */
  --encrypted-light:#c4b5fd;    /* violet-300 */
  --encrypted-deep: #8b5cf6;    /* violet-500 */
  --encrypted-dark: #7c3aed;    /* violet-600 */
  --encrypted-glow: rgba(167, 139, 250, 0.15);

  /* ── Status (harmonized -- all use -400 for dark bg contrast) ── */
  --success:        #34d399;    /* emerald-400 (matches accent) */
  --error:          #f87171;    /* red-400 (softer on dark) */
  --warning:        #fbbf24;    /* amber-400 */
  --info:           #60a5fa;    /* blue-400 */
}
```

### Full Accent Ramp (Tailwind tokens)

| Token | Hex | Usage |
|-------|-----|-------|
| `accent-50` | `#ecfdf5` | Barely-there tint backgrounds |
| `accent-100` | `#d1fae5` | -- |
| `accent-200` | `#a7f3d0` | -- |
| `accent-300` | `#6ee7b7` | Highlighted text, links on dark |
| `accent-400` | `#34d399` | **PRIMARY INTERACTIVE** -- buttons, nav, revealed amounts |
| `accent-500` | `#10b981` | Secondary, success indicators, pressed |
| `accent-600` | `#059669` | Active/pressed state for primary buttons |
| `accent-700` | `#047857` | Dark accent for subtle tints |
| `accent-900` | `#064e3b` | Background tint (`bg-accent-900/20`) |

### Why Emerald Accent (Not Cyan/Blue)

- Green = money. Universal association across every culture.
- Emerald specifically = premium/luxury (emerald cards, private banking)
- On dark backgrounds, #34d399 (400) reads more vibrant than #10b981 (500) while staying in the same hue
- Paired with violet = "your money is here, and it's protected"

---

## Public vs. Encrypted Visual Language

Every element must instantly communicate whether it is public or encrypted. The "two fonts" rule: **Inter = public, JetBrains Mono = encrypted.**

### Public Information (who, when, why)

| Property | Value | Tailwind |
|----------|-------|----------|
| Color (names) | `#f4f4f5` | `text-text-primary` |
| Color (metadata) | `#a1a1aa` | `text-text-secondary` |
| Font | Inter (sans-serif) | `font-sans` |
| Border | `rgba(255,255,255,0.10)` | `border-glass-border` |
| Background | Standard glass-surface | `bg-glass-surface` |

### Encrypted Information (amounts, balances)

| Property | Value | Tailwind |
|----------|-------|----------|
| Color (hidden) | `#a78bfa` at 60% | `text-encrypted-400/60` |
| Color (revealed) | `#34d399` | `text-accent-400` |
| Font | JetBrains Mono | `font-mono` |
| Border | `rgba(139,92,246,0.20)` | `border-encrypted-500/20` |
| Background | `rgba(139,92,246,0.05)` | `bg-encrypted-500/5` |
| Container class | -- | `.encrypted-container` |
| Badge class | -- | `.badge-encrypted` |

---

## Typography

### Font: Inter (Primary) + JetBrains Mono (Monospace)

| Token | Size | Line Height | Letter Spacing | Weight | Tailwind |
|-------|------|-------------|----------------|--------|----------|
| `display-xl` | 3.5rem (56px) | 1.05 | -0.035em | 700 | `text-display-xl font-bold` |
| `display` | 2.25rem (36px) | 1.1 | -0.025em | 700 | `text-display font-bold` |
| `heading-1` | 1.75rem (28px) | 1.15 | -0.02em | 600 | `text-heading-1 font-semibold` |
| `heading-2` | 1.375rem (22px) | 1.2 | -0.015em | 600 | `text-heading-2 font-semibold` |
| `heading-3` | 1.125rem (18px) | 1.3 | -0.01em | 600 | `text-heading-3 font-semibold` |
| `body-lg` | 1rem (16px) | 1.6 | 0 | 400 | `text-body-lg` |
| `body` | 0.875rem (14px) | 1.6 | 0 | 400 | `text-body` |
| `body-sm` | 0.8125rem (13px) | 1.5 | 0.005em | 400 | `text-body-sm` |
| `caption` | 0.75rem (12px) | 1.5 | 0.02em | 500 | `text-caption font-medium` |
| `label` | 0.6875rem (11px) | 1.4 | 0.08em | 600 | `text-label font-semibold uppercase` |
| `mono-display` | 2.5rem (40px) | 1.0 | -0.02em | 600 | `font-mono text-mono-display font-semibold` |
| `mono-amount` | 1.25rem (20px) | 1.0 | -0.01em | 600 | `font-mono text-mono-amount font-semibold tabular-nums` |
| `mono-small` | 0.8125rem (13px) | 1.4 | 0 | 400 | `font-mono text-mono-small` |

### Why Inter + JetBrains Mono

- Inter: The most readable UI font. Used by Linear, Vercel, Stripe.
- JetBrains Mono: Monospace for financial numbers ensures digit alignment (1111 same width as 8888). Critical for amounts.
- The pairing also serves as the public/encrypted visual signal (see above).

---

## Component Library

### GlassCard

The foundational container. Every content block uses this.

Glass panels use a top-lit gradient (not flat fill) + inset ring for bevel + multi-layer shadow.

```
Variants:
- default:  .glass-panel (gradient bg, border 10%, inset ring, 3-layer shadow)
- elevated: .glass-elevated (stronger gradient, border 14%, inset ring, 4-layer shadow with top-edge catch)
- outlined: bg-transparent backdrop-blur-xl border border-glass-border rounded-2xl
- interactive: .glass-panel + hover states + glass-interactive-glow

Premium add-on: .glass-highlight adds a 1px gradient line across the top edge
(emerald-to-violet gradient) for a "catching light" effect.

Entry animation (Framer Motion):
- initial: { opacity: 0, y: 8, scale: 0.99 }
- animate: { opacity: 1, y: 0, scale: 1 }
- transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] }

Hover:
- border-color transitions to border-hover (0.2s)
- Shimmer overlay sweeps on hover (for interactive cards)
```

### Button

```
Variants:
- primary:   .btn-accent-glow (gradient 400->500, glow shadow, text-inverse)
             Hover: gradient shifts to 300->400, glow intensifies
             Active: gradient shifts to 500->600, glow tightens
- secondary: bg-white/[0.06] text-white border border-glass-border
             Hover: bg-white/[0.10]
- outline:   bg-transparent border border-glass-border text-text-secondary
             Hover: border-glass-border-hover text-white
- ghost:     bg-transparent text-text-secondary
             Hover: text-white bg-white/[0.04]
- danger:    bg-error/10 text-error border border-error/20
             Hover: bg-error/20

Sizes: sm (h-8 px-3 text-xs), md (h-10 px-4 text-sm), lg (h-12 px-6 text-base)

All buttons: rounded-xl, transition-all 0.2s
Framer Motion: whileHover={{ scale: 1.02 }}, whileTap={{ scale: 0.98 }}
```

### Input

```
Base:
- bg-white/[0.04] border border-glass-border rounded-xl
- h-12 px-4 text-sm text-text-primary placeholder:text-text-muted
- Focus: border-accent/50 ring-1 ring-accent/20
- Bottom glow line on focus (2px gradient: transparent -> #34d399 -> transparent)

With label:
- Label above: .label class (text-label font-semibold text-text-tertiary uppercase tracking-[0.08em])

With error:
- border-error/50 ring-1 ring-error/20
- Error text below: text-xs text-error mt-1

Amount input special:
- JetBrains Mono font
- Right-aligned text
- Token symbol badge on right side
- Larger text (text-2xl) for amount display
```

### EncryptedAmount (Custom Component)

```
States:
- Hidden:    .encrypted-text class (gradient shimmer from zinc-600 to zinc-500)
             JetBrains Mono, tracking-[0.15em], select-none
             Slow background-position animation for subtle "alive" feel
- Revealing: Character scramble animation (0.3s, left-to-right settle)
- Revealed:  .revealed-text class
             JetBrains Mono, font-semibold, tabular-nums, tracking-[-0.01em]
             Color: accent-400 (#34d399)
             text-shadow: 0 0 12px rgba(52,211,153,0.35), 0 0 30px rgba(52,211,153,0.12)
- Auto-hide: After 10 seconds, dissolve back to hidden (fade color + re-scramble)

Interaction: Click/tap to reveal -> auto-hides after timeout

Sizing rule: Encrypted amounts should always be ONE STEP LARGER
than surrounding text for visual hierarchy.
```

### ActivityItem

```
Layout: Horizontal -> [avatar] [context] [amount] [time]

Context (public): Inter font, text-text-primary
Amount (encrypted): JetBrains Mono, .encrypted-text or .revealed-text
Time: text-text-tertiary

Hover: bg-glass-hover, border-glass-border-hover
Entry: staggered fadeInUp (0.06s delay per item)
```

### Shimmer (Loading Skeleton)

```
- .shimmer class: bg-white/[0.05], rounded-lg
- Pseudo-element sweep: gradient with rgba(255,255,255,0.07) center
- Animation: translateX(-100%) -> translateX(100%) over 1.5s, infinite
- Used IN-PLACE of real content (same dimensions) -- no layout shift
```

### Status Badges

```
- .badge-success: bg-success/10 text-success border-success/20
- .badge-error: bg-error/10 text-error border-error/20
- .badge-warning: bg-warning/10 text-warning border-warning/20
- .badge-info: bg-info/10 text-info border-info/20
- .badge-encrypted: bg-encrypted/10 text-encrypted border-encrypted/20

All: rounded-full px-2.5 py-0.5 text-caption font-medium
```

---

## Gradient Recipes

### 1. Hero Card Background

Emerald glow top-left, violet glow bottom-right. Says "money + encrypted" in one visual sweep.

```css
.gradient-hero {
  background:
    radial-gradient(ellipse at 30% 0%, rgba(52, 211, 153, 0.08) 0%, transparent 50%),
    radial-gradient(ellipse at 70% 100%, rgba(167, 139, 250, 0.06) 0%, transparent 50%),
    linear-gradient(180deg, #131316 0%, #0f0f12 100%);
}
```

### 2. Card Top-Edge Highlight

Single-pixel gradient line -- makes cards look like they catch light. The difference between a $5 component and a $500 one.

```css
.glass-highlight::before {
  /* Applied via CSS class -- see index.css */
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(52, 211, 153, 0.4) 30%,
    rgba(167, 139, 250, 0.3) 70%,
    transparent 100%
  );
}
```

### 3. Primary Button States

Three-state gradient that brightens on hover and darkens on press.

```css
/* Default: 400 -> 500 */
background: linear-gradient(135deg, #34d399 0%, #10b981 100%);

/* Hover: 300 -> 400 (brightens) */
background: linear-gradient(135deg, #6ee7b7 0%, #34d399 100%);

/* Active: 500 -> 600 (darkens) */
background: linear-gradient(135deg, #10b981 0%, #059669 100%);
```

### 4. Accent Gradient Text

For headlines or decorative text that spans emerald-to-violet.

```css
.gradient-accent-text {
  background: linear-gradient(135deg, #34d399, #a78bfa);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
```

---

## Animation System (Framer Motion)

### Page Transitions

```typescript
export const pageVariants = {
  initial: { opacity: 0, filter: "blur(8px)", y: 12 },
  animate: {
    opacity: 1,
    filter: "blur(0px)",
    y: 0,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] }
  },
  exit: {
    opacity: 0,
    filter: "blur(8px)",
    y: -8,
    transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] }
  }
};
```

### Staggered Lists

```typescript
export const staggerContainer = {
  animate: { transition: { staggerChildren: 0.06 } }
};

export const fadeInUp = {
  initial: { opacity: 0, y: 12 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] }
  }
};
```

### Interactive Elements

```typescript
// All buttons and interactive cards
whileHover={{ scale: 1.02 }}
whileTap={{ scale: 0.98 }}

// Navigation pill indicator
<motion.span layoutId="nav-indicator"
  className="absolute inset-0 bg-accent/10 border border-accent/20 rounded-full" />

// Tab indicator
<motion.div layoutId="active-tab"
  className="absolute bottom-0 h-0.5 bg-accent" />
```

### Encryption Animation (Custom)

```typescript
// When encrypting an amount -- show encryption "scramble" effect
// Characters settle left-to-right over 300ms
// When hiding again, dissolve color from accent-400 to zinc-600
// while characters re-scramble
```

---

## Background Treatment

### Multi-Layer Dark Background

```css
body {
  background: #09090b; /* zinc-950, not pure black */
  background-image:
    radial-gradient(ellipse at 20% 50%, rgba(52, 211, 153, 0.06) 0%, transparent 50%),
    radial-gradient(ellipse at 80% 20%, rgba(167, 139, 250, 0.04) 0%, transparent 50%),
    radial-gradient(ellipse at 50% 100%, rgba(52, 211, 153, 0.04) 0%, transparent 50%);
}

/* SVG noise texture overlay */
body::before { opacity: 0.03; /* fractal noise */ }
```

### Flashlight Effect (Desktop Only)

Mouse-tracking radial gradient overlay using accent-400 glow.

```css
.flashlight::after {
  background: radial-gradient(500px circle at var(--mouse-x) var(--mouse-y),
    rgba(52, 211, 153, 0.04), transparent 60%);
}
```

---

## Responsive Strategy

### Separate Component Trees

```typescript
const isMobile = useMediaQuery('(max-width: 768px)');
return isMobile
  ? <Suspense><MobileApp /></Suspense>
  : <Suspense><DesktopApp /></Suspense>;
```

### Desktop Layout
```
Fixed Navbar (glass pill, centered)
Sidebar (240px) | Main Content Area (max-w-4xl, centered)
```

### Mobile Layout
```
Compact Header
Full-Width Content (px-4)
Fixed Bottom Nav (glass pill, max 5 items)
```

---

## Patterns Adopted from NullPay

| Pattern | From NullPay | Our Improvement |
|---------|-------------|-----------------|
| layoutId sliding pill nav | Exact copy | Add accent glow on active |
| Page blur transitions | Exact copy | Add direction-aware (left/right) |
| GlassCard with auto-entry | Exact copy | Top-lit gradient + inset ring + 4 variants |
| Shimmer loading skeletons | Exact copy | Match exact data dimensions |
| Payment step state machine | TypeScript string union | Add encryption-specific steps |
| Hook-orchestrated components | Exact pattern | Same |
| Monochromatic dark theme | Similar but improved | Emerald accent + violet encrypted |
| Flashlight mouse effect | Exact copy (desktop) | Same |
| SVG noise texture | Exact copy | Same |
| Mobile/Desktop split | Separate component trees | Same + shared components |

## Patterns We Add (Not in NullPay)

| Pattern | Purpose |
|---------|---------|
| EncryptedAmount reveal animation | Tap to reveal, auto-hide -- core privacy UX |
| Encrypted-shimmer CSS animation | Gradient shimmer on hidden amounts for "alive" feel |
| Two-font public/encrypted signal | Inter = public, JetBrains Mono = encrypted |
| Glass-highlight top-edge gradient | Premium card highlight (emerald-to-violet) |
| Gradient button states | 3-state gradient (default/hover/pressed) |
| Encryption progress steps | Show encrypt -> prove -> verify -> submit |
| Permit management UI | Self/sharing/audit permits |
| QR scanner with camera | Mobile native scanning |
| Group expense split calculator | Per-person split UI |
| Creator tier badge system | Bronze/Silver/Gold encrypted tiers |
| Invoice PDF/CSV export | Client-side generation |
| Activity feed with encrypted amounts | Social feed with hidden amounts |
