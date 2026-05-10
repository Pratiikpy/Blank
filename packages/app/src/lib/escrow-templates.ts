// Pre-built milestone shapes for the Escrow flow.
//
// Real escrow contracts often have multiple milestones (e.g. 50% upfront,
// 50% on delivery). The on-chain BusinessHub.Escrow struct is currently
// single-milestone, so for Wave 3 these templates simply *suggest* a
// description + amount split — the user creates one escrow per milestone.
// A multi-milestone Escrow contract upgrade lives in the Wave 3 contract
// pass.

export interface MilestoneTemplate {
  /** Internal ID — referenced by the UI dropdown / state. */
  id: string;
  /** Human label shown in the dropdown. */
  label: string;
  /** One-line explainer rendered under the dropdown. */
  description: string;
  /** Splits as fractions of the total (must sum to 1.0). */
  splits: Array<{ name: string; fraction: number }>;
}

export const MILESTONE_TEMPLATES: MilestoneTemplate[] = [
  {
    id: "single",
    label: "Single milestone (default)",
    description: "One escrow, full amount released on delivery.",
    splits: [{ name: "Full delivery", fraction: 1 }],
  },
  {
    id: "50-50",
    label: "50% upfront / 50% on delivery",
    description: "Half locked at start, half released on completion.",
    splits: [
      { name: "Upfront", fraction: 0.5 },
      { name: "On delivery", fraction: 0.5 },
    ],
  },
  {
    id: "33-33-33",
    label: "33 / 33 / 33 (kickoff, midpoint, delivery)",
    description: "Three equal tranches: kickoff, midpoint review, final delivery.",
    splits: [
      { name: "Kickoff", fraction: 1 / 3 },
      { name: "Midpoint", fraction: 1 / 3 },
      { name: "Delivery", fraction: 1 / 3 },
    ],
  },
  {
    id: "25-50-25",
    label: "25 / 50 / 25 (kickoff, build, polish)",
    description: "Light on the ends, heavy in the middle. Useful for build-heavy projects.",
    splits: [
      { name: "Kickoff", fraction: 0.25 },
      { name: "Build", fraction: 0.5 },
      { name: "Polish", fraction: 0.25 },
    ],
  },
];

/** Compute per-milestone amounts from a plaintext total, rounded to 2 d.p.
 *  with the rounding error absorbed into the final milestone so the sum
 *  exactly equals `total`. */
export function applyTemplate(
  template: MilestoneTemplate,
  total: number,
): Array<{ name: string; amount: number }> {
  if (template.splits.length === 1) {
    return [{ name: template.splits[0].name, amount: total }];
  }
  const head = template.splits.slice(0, -1).map((s) => ({
    name: s.name,
    amount: Math.round(total * s.fraction * 100) / 100,
  }));
  const consumed = head.reduce((sum, m) => sum + m.amount, 0);
  const tail = template.splits[template.splits.length - 1];
  return [
    ...head,
    {
      name: tail.name,
      amount: Math.round((total - consumed) * 100) / 100,
    },
  ];
}
