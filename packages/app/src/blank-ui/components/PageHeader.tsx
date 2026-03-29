import { useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  rightAction?: React.ReactNode;
  onBack?: () => void;
}

export function PageHeader({
  title,
  subtitle,
  showBack = true,
  rightAction,
  onBack,
}: PageHeaderProps) {
  const navigate = useNavigate();

  return (
    <div className="page-header">
      {showBack && (
        <button
          className="page-header-back"
          onClick={onBack || (() => navigate(-1))}
          aria-label="Go back"
        >
          <ChevronLeft size={20} />
        </button>
      )}
      <div className="flex-1 min-w-0">
        <h1 className="text-h2 text-[var(--text-primary)] truncate">
          {title}
        </h1>
        {subtitle && (
          <p className="text-caption text-[var(--text-secondary)] mt-0.5">
            {subtitle}
          </p>
        )}
      </div>
      {rightAction && <div className="shrink-0">{rightAction}</div>}
    </div>
  );
}
