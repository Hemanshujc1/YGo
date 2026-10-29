import { createAdminApiClient } from "@ygo/api-client";
import { SearchTermBody, type SearchTerm } from "@ygo/contracts";
import { useState, type FormEvent } from "react";
import { useLoaderData } from "react-router";
import { fieldMessages } from "./lib/field-messages";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type FieldErrors = Partial<Record<keyof SearchTermBody, string>>;

// Plain character order, as the server sorts (COLLATE "C"), so rows don't move after a save.
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byWords = (a: SearchTerm, b: SearchTerm) => order(a.typedWord, b.typedWord) || order(a.catalogWord, b.catalogWord);

/** A13 search terms (#397, DSC-3): the denylist joins this page with #69. */
export function SearchTerms({ api }: { api: AdminApi }) {
  const loaded = useLoaderData() as SearchTerm[];
  const [terms, setTerms] = useState(loaded);
  const [editing, setEditing] = useState<SearchTerm | null>(null);
  const [form, setForm] = useState(false);
  const [typedWord, setTypedWord] = useState("");
  const [catalogWord, setCatalogWord] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  function openForm(term: SearchTerm | null) {
    setEditing(term);
    setTypedWord(term?.typedWord ?? "");
    setCatalogWord(term?.catalogWord ?? "");
    setErrors({});
    setError("");
    setDone("");
    setForm(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = SearchTermBody.safeParse({ typedWord, catalogWord });
    if (!parsed.success) {
      setErrors(fieldMessages(parsed.error.issues.map((issue) => String(issue.path[0])), strings.searchTermInvalidFields));
      return;
    }
    setBusy(true);
    setErrors({});
    setError("");
    try {
      const result = editing ? await api.editSearchTerm(editing.id, parsed.data) : await api.createSearchTerm(parsed.data);
      if (result.ok) {
        setTerms((current) => [...current.filter((term) => term.id !== result.data.id), result.data].sort(byWords));
        setDone(editing ? strings.searchTermSaved : strings.searchTermAdded);
        setForm(false);
      } else if (editing && result.code === "NOT_FOUND") {
        // Removed elsewhere: drop it here too.
        setTerms((current) => current.filter((term) => term.id !== editing.id));
        setError(strings.errors.NOT_FOUND);
        setForm(false);
      } else if (result.code === "VALIDATION_FAILED" && result.fields?.length) {
        setErrors(fieldMessages(result.fields, strings.searchTermInvalidFields));
      } else setError(strings.errors[result.code] ?? strings.failed);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  async function remove(term: SearchTerm) {
    setBusy(true);
    setDone("");
    setError("");
    try {
      const result = await api.removeSearchTerm(term.id);
      // Gone already counts as removed.
      if (result.ok || result.code === "NOT_FOUND") {
        setTerms((current) => current.filter((item) => item.id !== term.id));
        setDone(strings.searchTermRemoved);
      } else setError(strings.errors[result.code] ?? strings.failed);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="mb-8 flex items-center justify-between gap-4">
      <div><h1 className="text-title-large font-semibold">{strings.searchTerms}</h1><p className="mt-2 text-muted">{strings.searchTermIntro}</p></div>
      {!form && <button onClick={() => openForm(null)} className="h-10 shrink-0 rounded-lg bg-primary px-4 font-medium text-on-primary">{strings.newSearchTerm}</button>}
    </div>
    {done && <p role="status" className="mb-4 rounded-lg bg-success-subtle p-3 text-on-success-subtle">{done}</p>}
    {!form && error && <p role="alert" className="mb-4 text-danger">{error}</p>}
    {!form && <section className="rounded-xl border border-border bg-surface">
      {terms.length === 0 ? <p className="p-6 text-muted">{strings.noSearchTerms}</p> : <ul>
        {terms.map((term) => <li key={term.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4 first:border-t-0">
          <span><span className="font-medium">{term.typedWord}</span><span className="mx-2 text-muted">→</span>{term.catalogWord}</span>
          <div className="flex gap-2">
            <button type="button" disabled={busy} aria-label={strings.editSearchTerm(term.typedWord, term.catalogWord)} onClick={() => openForm(term)}
              className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">{strings.edit}</button>
            <button type="button" disabled={busy} aria-label={strings.removeSearchTerm(term.typedWord, term.catalogWord)} onClick={() => void remove(term)}
              className="h-10 rounded-lg border border-border-strong px-3 text-danger disabled:opacity-60">{strings.remove}</button>
          </div>
        </li>)}
      </ul>}
    </section>}
    {form && <section className="max-w-xl rounded-xl border border-border bg-surface p-6">
      <h2 className="text-body font-semibold">{editing ? strings.editSearchTermTitle : strings.newSearchTerm}</h2>
      <p className="mt-2 text-secondary text-muted">{strings.searchTermExample}</p>
      <form onSubmit={(event) => void save(event)} className="mt-6 space-y-4" noValidate>
        <div><label htmlFor="typed-word" className="mb-2 block font-medium">{strings.typedWord}</label>
          <input id="typed-word" value={typedWord} onChange={(event) => setTypedWord(event.target.value)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />
          {errors.typedWord && <p role="alert" className="mt-1 text-secondary text-danger">{errors.typedWord}</p>}</div>
        <div><label htmlFor="catalog-word" className="mb-2 block font-medium">{strings.catalogWord}</label>
          <input id="catalog-word" value={catalogWord} onChange={(event) => setCatalogWord(event.target.value)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />
          {errors.catalogWord && <p role="alert" className="mt-1 text-secondary text-danger">{errors.catalogWord}</p>}</div>
        {error && <p role="alert" className="text-danger">{error}</p>}
        <div className="flex gap-3"><button disabled={busy} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{busy ? strings.saving : strings.saveSearchTerm}</button>
          <button type="button" disabled={busy} onClick={() => { setError(""); setForm(false); }} className="h-10 rounded-lg border border-border-strong px-4">{strings.cancel}</button></div>
      </form>
    </section>}
  </>;
}
