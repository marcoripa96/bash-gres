import Link from "next/link";
import { TerminalDemo } from "./terminal-demo";
import { CopyButton } from "./copy-button";
import { AsciiHeader } from "./ascii-header";
import { Magnetic } from "./magnetic";
import { Marquee } from "./marquee";
import { getPackageVersion } from "@/lib/version";

export function Hero() {
  const version = getPackageVersion();
  return (
    <section className="pt-12 pb-0 lg:pt-20">
      <div className="max-w-[768px] mx-auto px-6 lg:px-8">
        <nav className="flex items-center justify-end gap-4 mb-8 font-mono text-xs">
          <Link
            href="/docs"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Docs
          </Link>
          <a
            href="https://github.com/marcoripa96/bash-gres"
            className="text-muted-foreground hover:text-foreground transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </nav>
        <AsciiHeader />
        <a
          href="https://www.npmjs.com/package/bash-gres"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-block font-mono text-[10px] sm:text-xs tracking-tight text-muted-foreground hover:text-foreground transition-colors border border-border/60 rounded-full px-2 py-0.5"
        >
          v{version}
        </a>
        <p className="mt-4 text-sm text-muted-foreground leading-relaxed max-w-[48ch]">
          PostgreSQL-backed virtual filesystem with a bash interface.
        </p>
        <div className="mt-4 flex items-center gap-3 font-mono text-sm text-muted">
          <Magnetic strength={0.4}>
            <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-1.5 cursor-pointer hover:border-zinc-600 transition-colors">
              <span className="text-muted select-none">$</span>
              <code className="text-foreground select-all text-xs">
                npm i bash-gres
              </code>
              <CopyButton text="npm install bash-gres" />
            </div>
          </Magnetic>
        </div>
        <div className="mt-8">
          <TerminalDemo />
        </div>
      </div>
      <div className="mt-10">
        <Marquee />
      </div>
    </section>
  );
}
