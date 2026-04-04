"use client";

const ITEMS = [
  "20 bash commands",
  "BM25 full-text search",
  "pgvector embeddings",
  "Row-Level Security",
  "multi-tenant isolation",
  "pipes & redirects",
  "glob expansion",
  "symlinks",
  "postgres.js",
  "Drizzle ORM",
  "just-bash",
  "access control",
  "hybrid search",
];

export function Marquee() {
  const content = ITEMS.map((item) => (
    <span key={item} className="flex items-center gap-4">
      <span className="text-muted-foreground">{item}</span>
      <span className="text-zinc-700">/</span>
    </span>
  ));

  return (
    <div className="relative overflow-hidden border-y border-border/30 py-3">
      <div className="flex gap-4 animate-marquee whitespace-nowrap font-mono text-xs">
        {content}
        {content}
      </div>
    </div>
  );
}
