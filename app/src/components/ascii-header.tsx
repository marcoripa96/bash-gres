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

  // Initial decode animation — single rAF loop instead of hundreds of timers
  useEffect(() => {
    const spans = spanRefs.current;
    const STEPS = 4;
    const STEP_MS = 30;

    // Pre-compute delay and state per cell
    const delays = new Float32Array(NON_SPACE.length);
    const step = new Int8Array(NON_SPACE.length); // -1 = waiting, 0..STEPS-1 = animating, STEPS = done
    step.fill(-1);

    for (let i = 0; i < NON_SPACE.length; i++) {
      const { col, row } = CELLS[NON_SPACE[i]];
      delays[i] = col * 16 + row * 25 + Math.random() * 50;
      const el = spans[NON_SPACE[i]];
      if (el) {
        el.textContent = rg();
        el.style.opacity = "0.15";
      }
    }

    let raf = 0;
    let done = 0;
    const start = performance.now();

    function tick(now: number) {
      const elapsed = now - start;

      for (let i = 0; i < NON_SPACE.length; i++) {
        if (step[i] === STEPS) continue;
        const el = spans[NON_SPACE[i]];
        if (!el) continue;

        if (step[i] === -1) {
          if (elapsed < delays[i]) continue;
          step[i] = 0;
        }

        const cellElapsed = elapsed - delays[i];
        const newStep = Math.min(STEPS, Math.floor(cellElapsed / STEP_MS));

        if (newStep > step[i]) {
          step[i] = newStep;
          if (newStep >= STEPS) {
            el.textContent = CELLS[NON_SPACE[i]].char;
            el.style.opacity = "1";
            done++;
          } else {
            el.textContent = rg();
            el.style.opacity = String(Math.min(1, 0.15 + newStep * 0.22));
          }
        }
      }

      if (done < NON_SPACE.length) {
        raf = requestAnimationFrame(tick);
      }
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
