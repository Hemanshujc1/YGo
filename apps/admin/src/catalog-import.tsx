import type { createAdminApiClient } from "@ygo/api-client";
import { CATALOG_IMPORT_CSV_FIELDS, CATALOG_IMPORT_FILE_FIELDS, CATALOG_IMPORT_FILE_LIMITS, type CatalogImportFileField, type CatalogImportPreviewResponse, type CatalogImportResponse, type CatalogImportRowErrors } from "@ygo/contracts";
import { parse } from "csv-parse/browser/esm/sync";
import { useState } from "react";
import { Link } from "react-router";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;

function download(csv: string, name: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function CatalogImport({ api }: { api: AdminApi }) {
  const [files, setFiles] = useState<Partial<Record<CatalogImportFileField, File>>>({});
  const [preview, setPreview] = useState<CatalogImportPreviewResponse | null>(null);
  const [problems, setProblems] = useState<CatalogImportRowErrors>([]);
  const [imported, setImported] = useState<CatalogImportResponse | null>(null);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [error, setError] = useState("");
  const [invalidParts, setInvalidParts] = useState<string[]>([]);
  const copy = strings.catalogImport;

  async function submit(commit: boolean) {
    const { catalogCsv, imagesZip } = files;
    if (!catalogCsv || !imagesZip) return;
    setBusy(commit ? "import" : "check");
    setError("");
    setInvalidParts([]);
    try {
      if (commit) {
        // Any failed commit needs a fresh check before another manual attempt.
        setPreview(null);
        const result = await api.commitCatalogImport({ catalogCsv, imagesZip });
        if (result.ok) setImported(result.data);
        else if (result.code === "CATALOG_IMPORT_ROWS_INVALID") setProblems(result.rowErrors ?? []);
        else { setError(strings.errors[result.code]); setInvalidParts(result.fields ?? []); }
      } else {
        setPreview(null);
        setProblems([]);
        const result = await api.previewCatalogImport({ catalogCsv, imagesZip });
        if (result.ok) { setPreview(result.data); setProblems(result.data.errors); }
        else { setError(strings.errors[result.code]); setInvalidParts(result.fields ?? []); }
      }
    } catch {
      setError(commit ? copy.commitUnconfirmed : strings.failed);
    } finally {
      setBusy(null);
    }
  }

  async function downloadProblems() {
    if (!files.catalogCsv) return;
    try {
      const file = files.catalogCsv;
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      });
      // Match the server's logical record numbering, including the header as record 1.
      const records = parse(text, { bom: true, relax_column_count: true });
      const rows = new Set(problems.map((problem) => problem.rowNumber));
      download(records.filter((_, index) => index === 0 || rows.has(index + 1))
        .map((record) => record.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n", "catalog-problems.csv");
    } catch {
      setError(copy.downloadFailed);
    }
  }

  const step = imported || busy === "import" ? 2 : preview || problems.length || busy === "check" ? 1 : 0;
  return <>
    <Link to="/products" className="text-primary">{copy.back}</Link>
    <div className="my-6 flex flex-wrap items-center justify-between gap-4">
      <h1 className="text-title-large font-semibold">{copy.title}</h1>
      <button type="button" onClick={() => download(`${CATALOG_IMPORT_CSV_FIELDS.join(",")}\r\n`, "catalog-template.csv")}
        className="h-10 rounded-lg border border-border-strong px-4">{copy.template}</button>
    </div>
    <ol aria-label={copy.stepsLabel} className="mb-6 flex flex-wrap gap-4">
      {copy.steps.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined}
        className={index === step ? "font-semibold text-primary" : "text-muted"}>{label}</li>)}
    </ol>
    <section aria-busy={busy !== null} className="space-y-6 rounded-xl border border-border bg-surface p-6">
      <p className="text-muted">{copy.hint(CATALOG_IMPORT_FILE_LIMITS.csvBytes / 1024 / 1024, CATALOG_IMPORT_FILE_LIMITS.imagesZipBytes / 1024 / 1024, CATALOG_IMPORT_FILE_LIMITS.imageBytes / 1024 / 1024)}</p>
      {!imported && <>
        {CATALOG_IMPORT_FILE_FIELDS.map((field) => <div key={field}>
          <label htmlFor={field} className="mb-2 block font-medium">{copy.parts[field]}</label>
          <input id={field} type="file" accept={field === "catalogCsv" ? ".csv,text/csv" : ".zip,application/zip"} disabled={busy !== null}
            aria-invalid={invalidParts.includes(field)} onChange={(event) => {
              setFiles({ ...files, [field]: event.target.files?.[0] });
              setPreview(null); setProblems([]); setError(""); setInvalidParts([]);
            }} className="block w-full text-secondary" />
          {invalidParts.includes(field) && <p className="mt-2 text-danger">{copy.invalidPart(copy.parts[field])}</p>}
        </div>)}
        <button type="button" disabled={busy !== null || !files.catalogCsv || !files.imagesZip} onClick={() => void submit(false)}
          className="h-10 rounded-lg border border-border-strong px-4 disabled:opacity-60">{busy === "check" ? strings.checking : copy.check}</button>
      </>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      {problems.length > 0 && <div>
        <h2 className="font-semibold text-danger">{copy.problems}</h2><p className="mt-2 text-muted">{copy.nothingImported}</p>
        <div className="mt-4 max-h-96 overflow-auto"><table className="w-full text-left">
          <thead><tr><th scope="col" className="p-2">{copy.row}</th><th scope="col" className="p-2">{copy.problem}</th></tr></thead>
          <tbody>{problems.map((problem, index) => <tr key={index} className="border-t border-border">
            <td className="p-2 tabular-nums">{problem.rowNumber}</td><td className="p-2">{copy.reasons[problem.reason]}{problem.field && ` (${copy.columns[problem.field]})`}</td>
          </tr>)}</tbody>
        </table></div>
        <button type="button" onClick={() => void downloadProblems()} className="mt-4 h-10 rounded-lg border border-border-strong px-4">{copy.download}</button>
      </div>}
      {preview && problems.length === 0 && !imported && <div>
        <p role="status">{copy.ready(preview.rowCount, preview.productCount, preview.packCount)}</p>
        <button type="button" disabled={busy !== null} onClick={() => void submit(true)}
          className="mt-4 h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{copy.commit}</button>
      </div>}
      {busy === "import" && <p role="status">{copy.importing}</p>}
      {imported && <div role="status"><h2 className="font-semibold">{copy.success}</h2>
        <p className="mt-2">{copy.summary(imported.productsCreated, imported.productsSkipped, imported.packsCreated, imported.packsSkipped)}</p>
        <button type="button" onClick={() => { setImported(null); setPreview(null); setProblems([]); setFiles({}); }}
          className="mt-4 h-10 rounded-lg border border-border-strong px-4">{copy.again}</button>
      </div>}
    </section>
  </>;
}
