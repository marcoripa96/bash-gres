const MINI_ASCII = `██████╗  ██████╗
██╔══██╗██╔════╝
██████╔╝██║  ███╗
██╔══██╗██║   ██║
██████╔╝╚██████╔╝
╚═════╝  ╚═════╝`;

export function Footer() {
  return (
    <footer className="border-t border-border/50 mt-8">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-8 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <pre className="font-mono text-[4px] leading-[1.1] text-muted select-none">
          {MINI_ASCII}
        </pre>
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
            href="https://github.com"
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
