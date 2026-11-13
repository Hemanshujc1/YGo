import type { Statement } from "@ygo/contracts";
import { useEffect, useRef } from "react";
import { Link, useLoaderData } from "react-router";
import { StatementDocument } from "./statement-document";
import { strings } from "./strings";

const text = strings.statements;

/** A18, one statement (ADM-6, MNY-12, #631). "Download PDF" opens the print page, where the browser's Print or Save as PDF makes the file. */
export function StatementDetail() {
  const statement = useLoaderData() as Statement;
  return <section>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <Link to="/statements" className="text-primary">{text.back}</Link>
      <a href={`/statements/${statement.id}/print`} target="_blank" rel="noopener" className="inline-flex h-11 items-center rounded-lg bg-primary px-4 font-medium text-on-primary">{text.downloadPdf}</a>
    </div>
    <StatementDocument statement={statement} />
  </section>;
}

/** Black on white, A4 landscape, nothing but the statement. */
const printCss = `@page { size: A4 landscape; margin: 12mm; }
@media print { html, body { background: #fff !important; color: #000 !important; } }
.statement-print .overflow-x-auto { overflow: visible !important; border-radius: 0 !important; }
.statement-print * { color: #000 !important; background: transparent !important; border-color: #000 !important; }
.statement-print table { width: 100%; border-collapse: collapse; }
.statement-print th, .statement-print td { border: 1px solid #000; padding: 4px 6px; font-size: 11px; }
.statement-print tr { break-inside: avoid; }`;

/**
 * The print-ready statement (#631): the browser's Print or Save as PDF saves it, named after the title. Opens the print dialog once, when the
 * statement has been drawn and the fonts are ready; no new dependency and no server-side PDF.
 */
export function StatementPrint() {
  const statement = useLoaderData() as Statement;
  const printed = useRef(false);
  useEffect(() => {
    const before = document.title;
    document.title = text.pdfTitle(statement.number);
    if (!printed.current) {
      printed.current = true;
      void (document.fonts?.ready ?? Promise.resolve()).then(() => window.print());
    }
    return () => { document.title = before; };
  }, [statement.number]);
  return <main className="statement-print min-h-screen bg-white p-6 text-black">
    <style>{printCss}</style>
    <StatementDocument statement={statement} />
  </main>;
}
