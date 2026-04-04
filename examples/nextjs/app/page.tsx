"use client";

import { useState, useRef, useEffect } from "react";

interface Line {
  type: "input" | "stdout" | "stderr";
  text: string;
}

export default function Home() {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cmd = input.trim();
    if (!cmd) return;

    setLines((prev) => [...prev, { type: "input", text: `$ ${cmd}` }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/bash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json();

      setLines((prev) => {
        const next = [...prev];
        if (data.stdout) next.push({ type: "stdout", text: data.stdout });
        if (data.stderr) next.push({ type: "stderr", text: data.stderr });
        return next;
      });
    } catch (err) {
      setLines((prev) => [
        ...prev,
        { type: "stderr", text: String(err) },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "2rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>bash-gres terminal</h1>
      <p style={{ color: "#666" }}>
        A PostgreSQL-backed virtual filesystem. Try: <code>mkdir docs</code>,{" "}
        <code>echo &quot;hello&quot; &gt; docs/readme.txt</code>,{" "}
        <code>ls -la</code>, <code>cat docs/readme.txt</code>
      </p>

      <div
        style={{
          background: "#1a1a2e",
          color: "#e0e0e0",
          borderRadius: 8,
          padding: "1rem",
          minHeight: 300,
          maxHeight: 500,
          overflowY: "auto",
          fontFamily: "monospace",
          fontSize: 14,
        }}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              color:
                line.type === "input"
                  ? "#7ec8e3"
                  : line.type === "stderr"
                    ? "#ff6b6b"
                    : "#e0e0e0",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {line.text}
          </div>
        ))}
        <div ref={bottomRef} />

        <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
          <span style={{ color: "#7ec8e3" }}>$</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            autoFocus
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#e0e0e0",
              fontFamily: "monospace",
              fontSize: 14,
            }}
          />
        </form>
      </div>
    </main>
  );
}
