interface FloatingLabelsProps {
  className?: string;
}

const labels = [
  { text: "euint64",        color: "#34d399", top: "6%",  left: "28%", anim: "hf-1"  },
  { text: "FHE.select()",   color: "#a78bfa", top: "4%",  left: "58%", anim: "hf-2"  },
  { text: "\u2588\u2588\u2588\u2588.\u2588\u2588",       color: "#e5e5e5", top: "22%", left: "82%", anim: "hf-3"  },
  { text: "Encrypted",      color: "#8b5cf6", top: "44%", left: "88%", anim: "hf-4"  },
  { text: "CoFHE",          color: "#10b981", top: "68%", left: "84%", anim: "hf-5"  },
  { text: "Shield",         color: "#60a5fa", top: "82%", left: "62%", anim: "hf-6"  },
  { text: "Permit",         color: "#fbbf24", top: "86%", left: "30%", anim: "hf-7"  },
  { text: "Homomorphic",    color: "#22d3ee", top: "70%", left: "4%",  anim: "hf-8"  },
  { text: "Base L2",        color: "#3b82f6", top: "46%", left: "2%",  anim: "hf-9"  },
  { text: "Private",        color: "#a78bfa", top: "20%", left: "6%",  anim: "hf-10" },
] as const;

const keyframes = `
@keyframes hf-1 {
  0%, 100% { transform: translate(0, 0); filter: blur(0px); }
  33%      { transform: translate(5px, -6px); filter: blur(1.4px); }
  66%      { transform: translate(-3px, 4px); filter: blur(0.3px); }
}
@keyframes hf-2 {
  0%, 100% { transform: translate(0, 0); filter: blur(0.2px); }
  40%      { transform: translate(-6px, 3px); filter: blur(1.6px); }
  75%      { transform: translate(4px, -5px); filter: blur(0px); }
}
@keyframes hf-3 {
  0%, 100% { transform: translate(0, 0); filter: blur(0px); }
  25%      { transform: translate(3px, 7px); filter: blur(1.2px); }
  60%      { transform: translate(-5px, -3px); filter: blur(0.5px); }
}
@keyframes hf-4 {
  0%, 100% { transform: translate(0, 0); filter: blur(0.4px); }
  35%      { transform: translate(-4px, -8px); filter: blur(1.8px); }
  70%      { transform: translate(6px, 3px); filter: blur(0px); }
}
@keyframes hf-5 {
  0%, 100% { transform: translate(0, 0); filter: blur(0px); }
  30%      { transform: translate(7px, 4px); filter: blur(1.5px); }
  65%      { transform: translate(-4px, -6px); filter: blur(0.2px); }
}
@keyframes hf-6 {
  0%, 100% { transform: translate(0, 0); filter: blur(0.3px); }
  45%      { transform: translate(-5px, -4px); filter: blur(1.3px); }
  80%      { transform: translate(3px, 7px); filter: blur(0px); }
}
@keyframes hf-7 {
  0%, 100% { transform: translate(0, 0); filter: blur(0px); }
  38%      { transform: translate(4px, 6px); filter: blur(1.7px); }
  72%      { transform: translate(-7px, -3px); filter: blur(0.4px); }
}
@keyframes hf-8 {
  0%, 100% { transform: translate(0, 0); filter: blur(0.1px); }
  28%      { transform: translate(-3px, -7px); filter: blur(1.4px); }
  58%      { transform: translate(6px, 5px); filter: blur(0px); }
}
@keyframes hf-9 {
  0%, 100% { transform: translate(0, 0); filter: blur(0px); }
  42%      { transform: translate(8px, -3px); filter: blur(1.6px); }
  78%      { transform: translate(-5px, 6px); filter: blur(0.3px); }
}
@keyframes hf-10 {
  0%, 100% { transform: translate(0, 0); filter: blur(0.2px); }
  32%      { transform: translate(-6px, 5px); filter: blur(1.2px); }
  68%      { transform: translate(4px, -8px); filter: blur(0px); }
}
`;

const durations = [
  "7.2s", "8.4s", "7.8s", "9.1s", "8.7s",
  "7.5s", "9.6s", "8.1s", "7.9s", "9.3s",
];

export default function FloatingLabels({ className = "" }: FloatingLabelsProps) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 scale-[0.65] sm:scale-75 md:scale-90 lg:scale-100 ${className}`}
      aria-hidden="true"
    >
      <style>{keyframes}</style>

      {labels.map((label, i) => (
        <span
          key={label.text}
          className="absolute inline-flex items-center gap-1.5 rounded-full font-medium tracking-wide select-none"
          style={{
            top: label.top,
            left: label.left,
            fontSize: "11px",
            lineHeight: 1,
            padding: "6px 12px",
            color: label.color,
            background: "rgba(255,255,255,0.03)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            border: "1px solid rgba(255,255,255,0.06)",
            animation: `${label.anim} ${durations[i]} ease-in-out infinite`,
            willChange: "transform, filter",
          }}
        >
          <span
            className="shrink-0 rounded-full"
            style={{
              width: 6,
              height: 6,
              backgroundColor: label.color,
              boxShadow: `0 0 8px ${label.color}`,
            }}
          />
          {label.text}
        </span>
      ))}
    </div>
  );
}
