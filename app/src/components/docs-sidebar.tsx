"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

const MINI_ASCII = `██████╗  ██████╗
██╔══██╗██╔════╝
██████╔╝██║  ███╗
██╔══██╗██║   ██║
██████╔╝╚██████╔╝
╚═════╝  ╚═════╝`;

const NAV = [
  {
    heading: "Getting Started",
    items: [
      { href: "/docs", label: "Overview" },
      { href: "/docs/connect", label: "Connect" },
      { href: "/docs/schema", label: "Schema & Setup" },
    ],
  },
  {
    heading: "Features",
    items: [
      { href: "/docs/filesystem", label: "Filesystem" },
      { href: "/docs/versioning", label: "Versioning" },
      { href: "/docs/search", label: "Search" },
      { href: "/docs/bash", label: "Bash" },
    ],
  },
  {
    heading: "Reference",
    items: [
      { href: "/docs/configuration", label: "Configuration" },
      { href: "/docs/errors", label: "Errors" },
    ],
  },
];

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 hidden lg:block">
      <div className="sticky top-8 space-y-6">
        <Link
          href="/"
          className="block text-muted hover:text-foreground transition-colors"
        >
          <pre className="font-mono text-[4px] leading-[1.1] select-none">
            {MINI_ASCII}
          </pre>
        </Link>
        <nav className="space-y-5">
          {NAV.map((section) => (
            <div key={section.heading}>
              <p className="font-mono text-[11px] font-medium tracking-widest uppercase text-muted mb-2">
                {section.heading}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={`block text-sm py-1 transition-colors ${
                          active
                            ? "text-foreground font-medium"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </aside>
  );
}

export function DocsMobileNav() {
  const pathname = usePathname();
  const allItems = NAV.flatMap((s) => s.items);

  return (
    <nav className="lg:hidden flex items-center gap-1 overflow-x-auto pb-4 mb-8 border-b border-border/50 -mx-6 px-6">
      {allItems.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`shrink-0 text-sm font-mono px-3 py-1.5 rounded-full transition-colors ${
              active
                ? "bg-white/[0.08] text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
