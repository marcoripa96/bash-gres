"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";

interface TocItem {
  id: string;
  label: string;
}

export function FloatingToc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  const [visible, setVisible] = useState(false);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const linkRefs = useRef<Map<string, HTMLAnchorElement>>(new Map());

  const activeIndex = useMemo(
    () => items.findIndex((i) => i.id === active),
    [items, active]
  );
  const prev = activeIndex > 0 ? items[activeIndex - 1] : null;
  const next = activeIndex < items.length - 1 ? items[activeIndex + 1] : null;

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }

  // Track active section
  useEffect(() => {
    const observers: IntersectionObserver[] = [];

    for (const item of items) {
      const el = document.getElementById(item.id);
      if (!el) continue;

      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) setActive(item.id);
        },
        { rootMargin: "-30% 0px -60% 0px" }
      );

      observer.observe(el);
      observers.push(observer);
    }

    return () => observers.forEach((o) => o.disconnect());
  }, [items]);

  // Show after scrolling past hero, hide near bottom
  useEffect(() => {
    const onScroll = () => {
      const scrolledPast = window.scrollY > 400;
      const nearBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;
      setVisible(scrolledPast && !nearBottom);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Slide indicator to active link (desktop)
  useEffect(() => {
    const link = linkRefs.current.get(active);
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!link || !container || !indicator) return;

    const containerRect = container.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();

    indicator.style.width = `${linkRect.width}px`;
    indicator.style.transform = `translateX(${linkRect.left - containerRect.left}px)`;
  }, [active]);

  const glassClass =
    "backdrop-blur-2xl backdrop-saturate-150 bg-zinc-900/50 border border-white/[0.1] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(0,0,0,0.2),0_0_0_1px_rgba(0,0,0,0.3),0_8px_40px_rgba(0,0,0,0.5),0_2px_8px_rgba(0,0,0,0.3)]";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50"
        >
          {/* Desktop: full bar */}
          <div
            ref={containerRef}
            className={`hidden md:flex relative items-center gap-0.5 px-1.5 py-1.5 rounded-full ${glassClass}`}
          >
            <div
              ref={indicatorRef}
              className="absolute top-1.5 left-0 h-[calc(100%-12px)] rounded-full bg-white/[0.08] transition-all duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)] pointer-events-none"
            />
            {items.map((item) => (
              <a
                key={item.id}
                ref={(el) => {
                  if (el) linkRefs.current.set(item.id, el);
                }}
                href={`#${item.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  scrollTo(item.id);
                }}
                className={`relative z-10 px-3 py-1.5 text-[12px] font-mono font-medium whitespace-nowrap rounded-full transition-colors duration-200 ${
                  active === item.id
                    ? "text-foreground"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {item.label}
              </a>
            ))}
          </div>

          {/* Mobile: prev / current / next */}
          <div
            className={`flex md:hidden items-center gap-1 px-1.5 py-1.5 rounded-full ${glassClass}`}
          >
            <button
              onClick={() => prev && scrollTo(prev.id)}
              disabled={!prev}
              className="relative z-10 flex items-center gap-1 pl-2.5 pr-1.5 py-1.5 rounded-full text-zinc-500 hover:text-zinc-300 disabled:opacity-0 disabled:pointer-events-none transition-all duration-200 active:scale-[0.92]"
              aria-label="Previous section"
            >
              <CaretLeft size={12} weight="bold" />
              <span className="text-[11px] font-mono">prev</span>
            </button>

            <div className="relative z-10 overflow-hidden min-w-[5rem]">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={active}
                  initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                  transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
                  className="block px-3 py-1 text-[12px] font-mono font-medium text-foreground whitespace-nowrap text-center"
                >
                  {items[activeIndex]?.label}
                </motion.span>
              </AnimatePresence>
            </div>

            <button
              onClick={() => next && scrollTo(next.id)}
              disabled={!next}
              className="relative z-10 flex items-center gap-1 pl-1.5 pr-2.5 py-1.5 rounded-full text-zinc-500 hover:text-zinc-300 disabled:opacity-0 disabled:pointer-events-none transition-all duration-200 active:scale-[0.92]"
              aria-label="Next section"
            >
              <span className="text-[11px] font-mono">next</span>
              <CaretRight size={12} weight="bold" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
