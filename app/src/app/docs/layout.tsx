import type { Metadata } from "next";
import { DocsSidebar, DocsMobileNav } from "@/components/docs-sidebar";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Docs -- BashGres",
  description:
    "Documentation for BashGres, a PostgreSQL-backed virtual filesystem with bash interface, full-text search, and multi-tenant isolation.",
};

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <main className="max-w-[1100px] mx-auto px-6 lg:px-8 pt-12 lg:pt-16 pb-24">
        <div className="flex gap-12">
          <DocsSidebar />
          <article className="min-w-0 flex-1 max-w-[768px]">
            <DocsMobileNav />
            {children}
          </article>
        </div>
      </main>
      <Footer />
    </>
  );
}
