import { highlight } from "@/lib/highlight";
import { CopyButton } from "./copy-button";

export async function CodeBlock({
  code,
  lang = "typescript",
  filename,
}: {
  code: string;
  lang?: string;
  filename?: string;
}) {
  const html = await highlight(code, lang);

  return (
    <div className="bg-surface/50 border border-border/50 rounded-xl overflow-hidden">
      {filename && (
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50">
          <span className="text-xs font-mono text-muted">{filename}</span>
          <CopyButton text={code} />
        </div>
      )}
      {!filename && (
        <div className="flex justify-end px-4 pt-3">
          <CopyButton text={code} />
        </div>
      )}
      <div className="p-4 overflow-x-auto [&_code]:text-[13px] [&_code]:leading-relaxed">
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
