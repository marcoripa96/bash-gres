"use client";

import { useEffect, useState } from "react";

interface DisplayLine {
  type: "cmd" | "output";
  text: string;
}

const SCRIPT: Array<
  | { kind: "cmd"; text: string }
  | { kind: "output"; text: string }
  | { kind: "pause"; ms: number }
> = [
  { kind: "cmd", text: "mkdir -p /project/docs" },
  { kind: "pause", ms: 300 },
  {
    kind: "cmd",
    text: 'echo "PostgreSQL-backed filesystem" > /project/docs/readme.md',
  },
  { kind: "pause", ms: 300 },
  { kind: "cmd", text: "cat /project/docs/readme.md" },
  { kind: "pause", ms: 150 },
  { kind: "output", text: "PostgreSQL-backed filesystem" },
  { kind: "pause", ms: 500 },
  { kind: "cmd", text: 'find / -name "*.md" -type f' },
  { kind: "pause", ms: 150 },
  { kind: "output", text: "/project/docs/readme.md" },
  { kind: "pause", ms: 500 },
  { kind: "cmd", text: "cat /project/docs/readme.md | wc -l" },
  { kind: "pause", ms: 150 },
  { kind: "output", text: "1" },
  { kind: "pause", ms: 500 },
  { kind: "cmd", text: 'grep "filesystem" /project -r' },
  { kind: "pause", ms: 150 },
  { kind: "output", text: "/project/docs/readme.md:PostgreSQL-backed filesystem" },
  { kind: "pause", ms: 2500 },
];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function TerminalDemo() {
  const [lines, setLines] = useState<DisplayLine[]>([]);
  const [typing, setTyping] = useState("");
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      while (!cancelled) {
        setLines([]);
        setTyping("");

        for (const step of SCRIPT) {
          if (cancelled) return;

          if (step.kind === "pause") {
            await sleep(step.ms);
          } else if (step.kind === "cmd") {
            for (let i = 0; i <= step.text.length; i++) {
              if (cancelled) return;
              setTyping(step.text.slice(0, i));
              await sleep(22 + Math.random() * 38);
            }
            await sleep(120);
            setTyping("");
            setLines((prev) => [...prev, { type: "cmd", text: step.text }]);
          } else {
            setLines((prev) => [
              ...prev,
              { type: "output", text: step.text },
            ]);
          }
        }
      }
    }

    run();

    const cursorInterval = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);

    return () => {
      cancelled = true;
      clearInterval(cursorInterval);
    };
  }, []);

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden font-mono text-[13px] leading-relaxed">
      <div className="p-4 h-[320px] overflow-hidden">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {line.type === "cmd" ? (
              <>
                <span className="text-muted-foreground">$ </span>
                <span className="text-foreground">{line.text}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{line.text}</span>
            )}
          </div>
        ))}
        <div className="whitespace-pre">
          <span className="text-muted-foreground">$ </span>
          <span className="text-foreground">{typing}</span>
          <span
            className={`text-muted-foreground transition-opacity duration-100 ${
              cursorVisible ? "opacity-100" : "opacity-0"
            }`}
          >
            _
          </span>
        </div>
      </div>
    </div>
  );
}
