"use client";

import { useState } from "react";
import { Copy, Check } from "@phosphor-icons/react";

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (label) {
    return (
      <button
        onClick={copy}
        className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors border border-border/60 rounded-full px-3 py-1.5 active:scale-[0.98]"
        aria-label={label}
      >
        {copied ? (
          <Check size={13} weight="bold" className="text-foreground" />
        ) : (
          <Copy size={13} />
        )}
        {copied ? "Copied!" : label}
      </button>
    );
  }

  return (
    <button
      onClick={copy}
      className="text-muted hover:text-foreground transition-colors p-1 active:scale-[0.95]"
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <Check size={14} weight="bold" className="text-foreground" />
      ) : (
        <Copy size={14} />
      )}
    </button>
  );
}
