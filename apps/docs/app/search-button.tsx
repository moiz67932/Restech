'use client';
import { useEffect, useState } from 'react';
type Entry = { slug: string; title: string; description: string };
export function SearchButton() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    fetch('/search-index.json')
      .then((r) => r.json())
      .then(setEntries)
      .catch(() => {});
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);
  const result = entries
    .filter((e) => (e.title + ' ' + e.description).toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);
  return (
    <>
      <button
        className="search-button"
        onClick={() => setOpen(true)}
        aria-label="Search documentation"
      >
        Search <kbd>⌘K</kbd>
      </button>
      {open && (
        <div className="search-backdrop" onClick={() => setOpen(false)}>
          <div
            className="search-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Search documentation"
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search guides, headers, error codes…"
            />
            <div>
              {result.map((e) => (
                <a href={'/docs/' + e.slug} key={e.slug}>
                  <strong>{e.title}</strong>
                  <small>{e.description}</small>
                </a>
              ))}
            </div>
            <button onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
