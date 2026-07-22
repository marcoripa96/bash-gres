"use client";

import { useState } from "react";
import { Check, Robot } from "@phosphor-icons/react";

export function SetupWithAgentButton({ guide }: { guide: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(guide);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-1.5 cursor-pointer hover:border-zinc-600 transition-colors text-xs text-foreground active:scale-[0.98]"
      aria-label="Copy the agent setup guide to clipboard"
      title="Copies a setup guide covering install to full setup — paste it to your coding agent"
    >
      {copied ? (
        <Check size={14} weight="bold" />
      ) : (
        <Robot size={14} />
      )}
      <span>{copied ? "guide copied" : "setup with your agent"}</span>
    </button>
  );
}
