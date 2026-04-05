import { TerminalDemo } from "./terminal-demo";
import { CopyButton } from "./copy-button";
import { AsciiHeader } from "./ascii-header";
import { Magnetic } from "./magnetic";
import { Marquee } from "./marquee";

export function Hero() {
  return (
    <section className="pt-12 pb-0 lg:pt-20">
      <div className="max-w-[768px] mx-auto px-6 lg:px-8">
        <AsciiHeader />
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
          <a
            href="https://github.com/marcoripa96/bash-gres"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
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
