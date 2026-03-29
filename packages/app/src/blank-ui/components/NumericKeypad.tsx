import { Delete } from "lucide-react";

interface NumericKeypadProps {
  onKey: (key: string) => void;
  onBackspace: () => void;
}

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"];

export function NumericKeypad({ onKey, onBackspace }: NumericKeypadProps) {
  return (
    <div className="keypad-grid">
      {keys.map((key) => (
        <button
          key={key}
          className="keypad-key"
          onClick={() => onKey(key)}
          aria-label={key === "." ? "Decimal point" : key}
        >
          {key}
        </button>
      ))}
      <button
        className="keypad-key !text-[var(--text-tertiary)]"
        onClick={onBackspace}
        aria-label="Backspace"
      >
        <Delete size={24} strokeWidth={1.5} />
      </button>
    </div>
  );
}
