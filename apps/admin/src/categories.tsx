import { createAdminApiClient } from "@ygo/api-client";
import { AdminActionReason, CreateCategoryBody, EditCategoryBody, type Category } from "@ygo/contracts";
import { useState, type FormEvent } from "react";
import { useLoaderData } from "react-router";
import { ReasonDialog } from "./components/reason-dialog";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type CategoryField = "name" | "parentId" | "reason";
type FieldErrors = Partial<Record<CategoryField, string>>;

export function Categories({ api }: { api: AdminApi }) {
  const loaded = useLoaderData() as Category[];
  const [categories, setCategories] = useState(loaded);
  const [editing, setEditing] = useState<Category | null>(null);
  const [screen, setScreen] = useState<"list" | "form" | "deactivate">("list");
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const roots = categories.filter((item) => item.parentId === null).sort((a, b) => a.name.localeCompare(b.name));
  const children = (id: string) => categories.filter((item) => item.parentId === id).sort((a, b) => a.name.localeCompare(b.name));

  function openForm(category: Category | null) {
    setEditing(category);
    setName(category?.name ?? "");
    setParentId(category?.parentId ?? null);
    setErrors({});
    setError("");
    setSaved(false);
    setScreen("form");
  }

  function finish(category: Category) {
    setCategories((current) => [...current.filter((item) => item.id !== category.id).map((item) =>
      item.parentId === category.id ? { ...item, effectiveActive: item.active && category.active } : item), category]);
    setSaved(true);
    setError("");
    setErrors({});
    setScreen("list");
  }

  function failed(code: string, fields?: string[]) {
    if (code === "CATEGORY_NAME_IN_USE") setErrors({ name: strings.errors.CATEGORY_NAME_IN_USE });
    else if (code === "VALIDATION_FAILED" && fields?.length) {
      setErrors(Object.fromEntries(fields.map((field) => [field, strings.categoryInvalidFields[field as CategoryField]])));
    } else setError(strings.errors[code as keyof typeof strings.errors] ?? strings.failed);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = editing
      ? EditCategoryBody.safeParse({ name, parentId })
      : CreateCategoryBody.safeParse({ name, parentId });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((issue) => {
        const field = issue.path[0] as CategoryField;
        return [field, strings.categoryInvalidFields[field]];
      })));
      return;
    }
    setBusy(true);
    setErrors({});
    setError("");
    try {
      const result = editing
        ? await api.editCategory(editing.id, parsed.data)
        : await api.createCategory(parsed.data as CreateCategoryBody);
      if (result.ok) finish(result.data);
      else failed(result.code, result.fields);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  async function changeActive(category: Category, active: boolean, text?: string) {
    setSaved(false);
    const parsed = EditCategoryBody.safeParse({ active, ...(text !== undefined && { reason: text }) });
    if (!parsed.success) {
      setErrors({ reason: strings.categoryInvalidFields.reason });
      return;
    }
    setBusy(true);
    setError("");
    setErrors({});
    try {
      const result = await api.editCategory(category.id, parsed.data);
      if (result.ok) finish(result.data);
      else if (active) setError(strings.failed);
      else failed(result.code, result.fields);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  function deactivate(text: string) {
    if (!editing) return;
    const parsed = AdminActionReason.safeParse(text);
    if (!parsed.success) return setErrors({ reason: strings.categoryInvalidFields.reason });
    void changeActive(editing, false, parsed.data);
  }

  function row(category: Category) {
    const status = !category.active ? strings.categoryInactive
      : !category.effectiveActive ? strings.categoryInactiveViaParent : strings.categoryActive;
    return <li key={category.id} className="border-t border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><span className="font-medium">{category.name}</span><span className="ml-3 text-secondary text-muted">{status}</span></div>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => openForm(category)} className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">
            {strings.editCategory(category.name)}
          </button>
          <button type="button" disabled={busy} onClick={() => {
            if (category.active) { setEditing(category); setErrors({}); setError(""); setSaved(false); setScreen("deactivate"); }
            else void changeActive(category, true);
          }} className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">
            {category.active ? strings.deactivateCategory(category.name) : strings.reactivateCategory(category.name)}
          </button>
        </div>
      </div>
      {category.parentId === null && children(category.id).length > 0 && <ul className="ml-5 mt-3 border-l border-border pl-3">
        {children(category.id).map(row)}
      </ul>}
    </li>;
  }

  return <>
    <div className="mb-8 flex items-center justify-between gap-4">
      <div><h1 className="text-title-large font-semibold">{strings.categories}</h1><p className="mt-2 text-muted">{strings.categoryIntro}</p></div>
      {screen === "list" && <button onClick={() => openForm(null)} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary">{strings.newCategory}</button>}
    </div>
    {saved && <p role="status" className="mb-4 rounded-lg bg-success-subtle p-3 text-on-success-subtle">{strings.categorySaved}</p>}
    {screen === "list" && error && <p role="alert" className="mb-4 text-danger">{error}</p>}
    {(screen === "list" || screen === "deactivate") && <section className="rounded-xl border border-border bg-surface">
      {categories.length === 0 ? <p className="p-6 text-muted">{strings.noCategories}</p> : <ul>{roots.map(row)}</ul>}
    </section>}
    {screen === "form" && <section className="max-w-xl rounded-xl border border-border bg-surface p-6">
      <h2 className="text-body font-semibold">{editing ? strings.editCategoryTitle : strings.newCategory}</h2>
      <form onSubmit={(event) => void save(event)} className="mt-6 space-y-4" noValidate>
        <div><label htmlFor="category-name" className="mb-2 block font-medium">{strings.categoryName}</label>
          <input id="category-name" value={name} onChange={(event) => setName(event.target.value)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />
          {errors.name && <p role="alert" className="mt-1 text-secondary text-danger">{errors.name}</p>}</div>
        <div><label htmlFor="category-parent" className="mb-2 block font-medium">{strings.categoryParent}</label>
          <select id="category-parent" value={parentId ?? ""} onChange={(event) => setParentId(event.target.value || null)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3">
            <option value="">{strings.topLevel}</option>
            {(!editing || children(editing.id).length === 0) && roots.filter((item) => item.id !== editing?.id).map((item) =>
              <option key={item.id} value={item.id}>{item.name}{item.active ? "" : strings.inactiveOption}</option>)}
          </select>
          {errors.parentId && <p role="alert" className="mt-1 text-secondary text-danger">{errors.parentId}</p>}</div>
        {error && <p role="alert" className="text-danger">{error}</p>}
        <div className="flex gap-3"><button disabled={busy} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{busy ? strings.saving : strings.saveCategory}</button>
          <button type="button" disabled={busy} onClick={() => setScreen("list")} className="h-10 rounded-lg border border-border-strong px-4">{strings.cancel}</button></div>
      </form>
    </section>}
    {screen === "deactivate" && editing && <ReasonDialog title={strings.deactivateCategoryTitle(editing.name)} confirmLabel={strings.confirmDeactivate} danger
      note={children(editing.id).length > 0 ? strings.deactivateParentWarning : undefined}
      busy={busy} reasonError={errors.reason} error={error} onConfirm={deactivate} onCancel={() => setScreen("list")} />}
  </>;
}
