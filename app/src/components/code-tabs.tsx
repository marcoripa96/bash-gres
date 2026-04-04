"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";

interface Tab {
  label: string;
  code: string;
  html: string;
}

export function CodeTabs({
  tabs,
  className,
}: {
  tabs: Tab[];
  className?: string;
}) {
  const [activeTab, setActiveTab] = useState(0);

  return (
    <div
      className={`bg-surface/50 border border-border/50 rounded-xl overflow-hidden ${className ?? ""}`}
    >
      <div className="flex items-center border-b border-border/50 overflow-x-auto">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            onClick={() => setActiveTab(i)}
            className={`px-5 py-3 text-sm font-mono font-medium whitespace-nowrap transition-colors relative active:scale-[0.98] ${
              i === activeTab
                ? "text-foreground"
                : "text-muted hover:text-muted-foreground"
            }`}
          >
            {tab.label}
            {i === activeTab && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground" />
            )}
          </button>
        ))}
        <div className="ml-auto pr-4 flex items-center">
          <CopyButton text={tabs[activeTab].code} />
        </div>
      </div>
      <div className="p-5 overflow-x-auto [&_code]:text-[13px] [&_code]:leading-relaxed">
        <div dangerouslySetInnerHTML={{ __html: tabs[activeTab].html }} />
      </div>
    </div>
  );
}
