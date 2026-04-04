"use client";

import { useRef, useEffect } from "react";

const ASCII = `██████╗  █████╗ ███████╗██╗  ██╗ ██████╗ ██████╗ ███████╗███████╗
██╔══██╗██╔══██╗██╔════╝██║  ██║██╔════╝ ██╔══██╗██╔════╝██╔════╝
██████╔╝███████║███████╗███████║██║  ███╗██████╔╝█████╗  ███████╗
██╔══██╗██╔══██║╚════██║██╔══██║██║   ██║██╔══██╗██╔══╝  ╚════██║
██████╔╝██║  ██║███████║██║  ██║╚██████╔╝██║  ██║███████╗███████║
╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝`;

const COLS = Math.max(...ASCII.split("\n").map((l) => l.length));
const ROWS = ASCII.split("\n").length;
const GLITCH = "░▒▓╳┃━┏┓┗┛╋╸╺╻╹▐▌▀▄";

function rg() {
  return GLITCH[Math.floor(Math.random() * GLITCH.length)];
}

interface Cell {
  char: string;
  col: number;
  row: number;
}

function buildGrid(): Cell[] {
  const cells: Cell[] = [];
  let row = 0,
    col = 0;
  for (const ch of ASCII) {
    if (ch === "\n") {
      cells.push({ char: ch, col: -1, row: -1 });
      row++;
      col = 0;
    } else {
      cells.push({ char: ch, col, row });
      col++;
    }
  }
  return cells;
}

export function AsciiHeader() {
  const containerRef = useRef<HTMLDivElement>(null);
  const spanRefs = useRef<Map<number, HTMLSpanElement>>(new Map());
  const cooldowns = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const grid = useRef<Cell[]>(buildGrid());
  const cells = grid.current;

  // Initial decode animation: characters start as glitch, resolve left-to-right
  useEffect(() => {
    const nonSpace: number[] = [];

    cells.forEach((c, i) => {
      if (c.char !== " " && c.char !== "\n") {
        nonSpace.push(i);
        const el = spanRefs.current.get(i);
        if (el) {
          el.textContent = rg();
          el.style.opacity = "0.15";
        }
      }
    });

    const timeouts: ReturnType<typeof setTimeout>[] = [];

    nonSpace.forEach((idx) => {
      const { col, row } = cells[idx];
      const delay = col * 16 + row * 25 + Math.random() * 50;

      const t = setTimeout(() => {
        const el = spanRefs.current.get(idx);
        if (!el) return;
        let n = 0;
        const iv = setInterval(() => {
          el.textContent = rg();
          el.style.opacity = String(Math.min(1, 0.15 + n * 0.22));
          n++;
          if (n >= 4) {
            clearInterval(iv);
            el.textContent = cells[idx].char;
            el.style.opacity = "1";
          }
        }, 30);
      }, delay);
      timeouts.push(t);
    });

    return () => timeouts.forEach(clearTimeout);
  }, [cells]);

  // Mouse proximity scramble
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let raf = 0;
    const cd = cooldowns.current;

    function onMove(e: MouseEvent) {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = container!.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const cw = rect.width / COLS;
        const ch = rect.height / ROWS;
        const radius = 4.5;

        cells.forEach((c, i) => {
          if (c.col < 0 || c.char === " " || cd.has(i)) return;
          const dx = mx / cw - (c.col + 0.5);
          const dy = my / ch - (c.row + 0.5);
          if (dx * dx + dy * dy < radius * radius) {
            const el = spanRefs.current.get(i);
            if (!el) return;
            el.textContent = rg();
            el.style.opacity = "0.4";
            const t = setTimeout(() => {
              el.textContent = c.char;
              el.style.opacity = "1";
              cd.delete(i);
            }, 80 + Math.random() * 120);
            cd.set(i, t);
          }
        });
      });
    }

    container.addEventListener("mousemove", onMove);
    return () => {
      container.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
      cd.forEach(clearTimeout);
    };
  }, [cells]);

  return (
    <div
      ref={containerRef}
      className="relative select-none overflow-hidden cursor-crosshair w-fit"
    >
      <pre className="font-mono text-[6px] sm:text-[8px] md:text-[10px] leading-[1.2] text-foreground whitespace-pre">
        {cells.map((c, i) =>
          c.char === "\n" ? (
            "\n"
          ) : (
            <span
              key={i}
              ref={(el) => {
                if (el) spanRefs.current.set(i, el);
              }}
            >
              {c.char}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}
