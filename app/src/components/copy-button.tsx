"use client";

import { useState } from "react";
import { Copy, Check } from "@phosphor-icons/react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
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
