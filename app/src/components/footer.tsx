import { Database } from "@phosphor-icons/react/dist/ssr";

export function Footer() {
  return (
    <footer className="border-t border-border/50 mt-8">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-8 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-muted">
          <Database size={14} weight="duotone" />
          <span className="font-mono text-sm">BashGres</span>
        </div>
        <div className="flex items-center gap-6 text-sm text-muted-foreground">
          <a
            href="https://www.npmjs.com/package/bash-gres"
            className="hover:text-foreground transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            npm
          </a>
          <a
            href="https://github.com/marcoripa96/bash-gres"
            className="hover:text-foreground transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <span className="text-muted">MIT License</span>
        </div>
      </div>
    </footer>
  );
}
