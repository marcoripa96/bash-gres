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
const RADIUS = 4.5;
const RADIUS_SQ = RADIUS * RADIUS;
const RADIUS_CEIL = Math.ceil(RADIUS);

function rg() {
  return GLITCH[Math.floor(Math.random() * GLITCH.length)];
}

interface Cell {
  char: string;
  col: number;
  row: number;
}

// Pre-compute grid and spatial lookup once
const CELLS: Cell[] = [];
const NON_SPACE: number[] = [];
// 2D grid: GRID[row][col] = index into CELLS (or -1 for spaces/newlines)
const GRID: number[][] = Array.from({ length: ROWS }, () =>
  new Array(COLS).fill(-1),
);

{
  let row = 0,
    col = 0;
  for (const ch of ASCII) {
    if (ch === "\n") {
      CELLS.push({ char: ch, col: -1, row: -1 });
      row++;
      col = 0;
    } else {
      const idx = CELLS.length;
      CELLS.push({ char: ch, col, row });
      if (ch !== " ") {
        NON_SPACE.push(idx);
        GRID[row][col] = idx;
      }
      col++;
    }
  }
}

export function AsciiHeader() {
  const containerRef = useRef<HTMLDivElement>(null);
  const spanRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const cooldowns = useRef<(ReturnType<typeof setTimeout> | null)[]>([]);

  // Initial decode animation
  useEffect(() => {
    const spans = spanRefs.current;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    for (const idx of NON_SPACE) {
      const el = spans[idx];
      if (el) {
        el.textContent = rg();
        el.style.opacity = "0.15";
      }
    }

    for (const idx of NON_SPACE) {
      const { col, row } = CELLS[idx];
      const delay = col * 16 + row * 25 + Math.random() * 50;

      const t = setTimeout(() => {
        const el = spans[idx];
        if (!el) return;
        let n = 0;
        const iv = setInterval(() => {
          el.textContent = rg();
          el.style.opacity = String(Math.min(1, 0.15 + n * 0.22));
          n++;
          if (n >= 4) {
            clearInterval(iv);
            el.textContent = CELLS[idx].char;
            el.style.opacity = "1";
          }
        }, 30);
      }, delay);
      timeouts.push(t);
    }

    return () => timeouts.forEach(clearTimeout);
  }, []);

  // Mouse proximity scramble
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let raf = 0;
    const cd = cooldowns.current;
    const spans = spanRefs.current;

    function onMove(e: MouseEvent) {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = container!.getBoundingClientRect();
        const cw = rect.width / COLS;
        const ch = rect.height / ROWS;
        const mcol = (e.clientX - rect.left) / cw;
        const mrow = (e.clientY - rect.top) / ch;

        const rMin = Math.max(0, Math.floor(mrow - RADIUS_CEIL));
        const rMax = Math.min(ROWS - 1, Math.ceil(mrow + RADIUS_CEIL));
        const cMin = Math.max(0, Math.floor(mcol - RADIUS_CEIL));
        const cMax = Math.min(COLS - 1, Math.ceil(mcol + RADIUS_CEIL));

        for (let r = rMin; r <= rMax; r++) {
          const gridRow = GRID[r];
          for (let c = cMin; c <= cMax; c++) {
            const idx = gridRow[c];
            if (idx < 0 || cd[idx]) continue;
            const dx = mcol - (c + 0.5);
            const dy = mrow - (r + 0.5);
            if (dx * dx + dy * dy >= RADIUS_SQ) continue;
            const el = spans[idx];
            if (!el) continue;
            el.textContent = rg();
            el.style.opacity = "0.4";
            cd[idx] = setTimeout(() => {
              el.textContent = CELLS[idx].char;
              el.style.opacity = "1";
              cd[idx] = null;
            }, 80 + Math.random() * 120);
          }
        }
      });
    }

    container.addEventListener("mousemove", onMove);
    return () => {
      container.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
      for (const t of cd) {
        if (t) clearTimeout(t);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative select-none overflow-hidden cursor-crosshair w-fit"
    >
      <pre className="font-mono text-[6px] sm:text-[8px] md:text-[10px] leading-[1.2] text-foreground whitespace-pre">
        {CELLS.map((c, i) =>
          c.char === "\n" ? (
            "\n"
          ) : (
            <span
              key={i}
              ref={(el) => {
                spanRefs.current[i] = el;
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
