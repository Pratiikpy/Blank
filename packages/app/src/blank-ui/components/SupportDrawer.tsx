import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { X, Search, ArrowUpRight, ExternalLink } from "lucide-react";

import { searchHelp, type HelpArticle } from "@/blank-ui/docs/help-articles";

interface SupportDrawerProps {
  open: boolean;
  onClose: () => void;
}

// Wave 5 Block 8 — in-app support drawer.
//
// Opens from the `?` button in the header. Lunr-style search across
// title + body + keywords + category. Article body rendered as plain
// text with basic newline handling (not full Markdown — keeps the
// drawer dependency-free).
//
// Selecting an article shows the body inline. The article's CTA
// deep-links to the relevant in-app surface.

export function SupportDrawer({ open, onClose }: SupportDrawerProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<HelpArticle | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelected(null);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const results = useMemo(() => searchHelp(query), [query]);

  if (!open) return null;

  return (
    <div
      data-testid="support-drawer"
      className="fixed inset-0 z-50 flex"
      onClick={onClose}
    >
      <div className="flex-1 bg-black/40" />
      <aside
        className="w-full max-w-md h-full bg-white shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 bg-white border-b border-black/5 px-5 py-4 flex items-center gap-3">
          <h2 className="text-lg font-semibold flex-1">Help &amp; support</h2>
          <button
            data-testid="support-drawer-close"
            onClick={onClose}
            aria-label="Close"
            className="p-2 rounded-xl hover:bg-black/5"
          >
            <X size={18} />
          </button>
        </header>

        {selected ? (
          <ArticleView article={selected} onBack={() => setSelected(null)} />
        ) : (
          <>
            <div className="p-5">
              <label className="block">
                <span className="sr-only">Search help</span>
                <div className="flex items-center gap-2 h-12 px-4 rounded-2xl bg-slate-100 border border-slate-200">
                  <Search size={16} className="text-slate-500" />
                  <input
                    data-testid="support-drawer-search"
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search 10 articles…"
                    className="flex-1 bg-transparent outline-none text-sm"
                  />
                </div>
              </label>
            </div>

            <div className="px-5 pb-5">
              {results.length === 0 ? (
                <div className="text-sm text-[var(--text-secondary)] text-center py-12">
                  No articles match "{query}". Try a different keyword.
                </div>
              ) : (
                <ul className="divide-y divide-black/5">
                  {results.map((a) => (
                    <li key={a.slug}>
                      <button
                        data-testid={`support-article-${a.slug}`}
                        onClick={() => setSelected(a)}
                        className="w-full text-left py-4 px-2 hover:bg-slate-50 rounded-lg flex items-start gap-3"
                      >
                        <div className="flex-1">
                          <div className="text-sm font-medium">{a.title}</div>
                          <div className="text-xs text-[var(--text-secondary)] mt-1">{a.category}</div>
                        </div>
                        <ArrowUpRight size={14} className="text-[var(--text-secondary)] shrink-0 mt-1" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <footer className="px-5 py-4 border-t border-black/5 text-xs text-[var(--text-secondary)] space-y-1">
              <div>
                External docs:{" "}
                <a
                  href="https://docs.myblank.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline inline-flex items-center gap-1"
                >
                  docs.myblank.app <ExternalLink size={10} />
                </a>
              </div>
              <div>
                Status:{" "}
                <Link to="/status" className="underline">/status</Link>
              </div>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}

function ArticleView({ article, onBack }: { article: HelpArticle; onBack: () => void }) {
  return (
    <div className="p-5">
      <button
        data-testid="support-article-back"
        onClick={onBack}
        className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-4"
      >
        ← All articles
      </button>
      <h3 className="text-xl font-semibold mb-1">{article.title}</h3>
      <div className="text-xs text-[var(--text-secondary)] mb-4">{article.category}</div>
      <div
        data-testid="support-article-body"
        className="prose prose-sm text-sm leading-relaxed whitespace-pre-wrap"
      >
        {article.body}
      </div>
      {article.cta && (
        <Link
          to={article.cta.href}
          className="mt-6 inline-flex items-center gap-2 h-11 px-5 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black"
        >
          {article.cta.label} <ArrowUpRight size={14} />
        </Link>
      )}
    </div>
  );
}
