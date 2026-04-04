"use client";

import { motion } from "framer-motion";

const ASCII = `
██████╗  █████╗ ███████╗██╗  ██╗ ██████╗ ██████╗ ███████╗███████╗
██╔══██╗██╔══██╗██╔════╝██║  ██║██╔════╝ ██╔══██╗██╔════╝██╔════╝
██████╔╝███████║███████╗███████║██║  ███╗██████╔╝█████╗  ███████╗
██╔══██╗██╔══██║╚════██║██╔══██║██║   ██║██╔══██╗██╔══╝  ╚════██║
██████╔╝██║  ██║███████║██║  ██║╚██████╔╝██║  ██║███████╗███████║
╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝`.trimStart();

export function AsciiHeader() {
  return (
    <div className="relative select-none overflow-hidden">
      <pre className="font-mono text-[6px] sm:text-[8px] md:text-[10px] leading-[1.2] text-zinc-800 whitespace-pre">
        {ASCII}
      </pre>
      <motion.pre
        className="absolute inset-0 font-mono text-[6px] sm:text-[8px] md:text-[10px] leading-[1.2] text-foreground whitespace-pre"
        initial={{ clipPath: "inset(0 100% 0 0)" }}
        animate={{ clipPath: "inset(0 0% 0 0)" }}
        transition={{ duration: 1.5, ease: [0.25, 0.1, 0.25, 1], delay: 0.2 }}
      >
        {ASCII}
      </motion.pre>
    </div>
  );
}
