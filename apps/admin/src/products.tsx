import { createAdminApiClient } from "@ygo/api-client";
import {
  AdminActionReason,
  CreateMasterProductBody,
  EditMasterProductBody,
  type Category,
  type MasterProduct,
} from "@ygo/contracts";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useLoaderData } from "react-router";
import { ReasonDialog } from "./components/reason-dialog";
import { fieldMessages } from "./lib/field-messages";
import { Packs } from "./packs";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type ProductBaseUnit = MasterProduct["baseUnit"];
type ProductField = "name" | "brand" | "categoryId" | "baseUnit" | "classification" | "image" | "reason";
type FieldErrors = Partial<Record<ProductField, string>>;
type LoadedProducts = { products: MasterProduct[]; categories: Category[] };

function readImage(file: File): Promise<{ base64: string; preview: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return reject(new Error("Image read failed"));
      resolve({ base64: reader.result.slice(reader.result.indexOf(",") + 1), preview: reader.result });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Products({ api }: { api: AdminApi }) {
  const loaded = useLoaderData() as LoadedProducts;
  const [products, setProducts] = useState(loaded.products);
  const [screen, setScreen] = useState<"list" | "form">("list");
  const [editing, setEditing] = useState<MasterProduct | null>(null);
  const [packing, setPacking] = useState<MasterProduct | null>(null);
  const [deactivating, setDeactivating] = useState<MasterProduct | null>(null);
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [baseUnit, setBaseUnit] = useState<ProductBaseUnit>("each");
  const [image, setImage] = useState("");
  const [preview, setPreview] = useState("");
  const [search, setSearch] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  function openForm(product: MasterProduct | null) {
    setScreen("form");
    setEditing(product);
    setName(product?.name ?? "");
    setBrand(product?.brand ?? "");
    setCategoryId(product?.categoryId ?? loaded.categories.find((category) => category.effectiveActive)?.id ?? "");
    setBaseUnit(product?.baseUnit ?? "each");
    setImage("");
    setPreview("");
    setErrors({});
    setError("");
    setSaved("");
  }

  function finish(product: MasterProduct, notice = strings.productSaved) {
    setProducts((current) => [...current.filter((item) => item.id !== product.id), product].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.brand ?? "").toLowerCase().localeCompare((b.brand ?? "").toLowerCase())));
    setSaved(notice);
    setError("");
    setErrors({});
    setEditing(null);
    setDeactivating(null);
    setScreen("list");
  }

  function failed(code: string, fields?: string[]) {
    if (code === "PRODUCT_NAME_IN_USE") setErrors({ name: strings.errors.PRODUCT_NAME_IN_USE });
    else if (code === "VALIDATION_FAILED" && fields?.length) setErrors(fieldMessages(fields, strings.productInvalidFields));
    else setError(strings.errors[code as keyof typeof strings.errors] ?? strings.failed);
  }

  async function chooseImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setErrors({});
    setError("");
    setBusy(true);
    try {
      const selected = await readImage(file);
      setImage(selected.base64);
      setPreview(selected.preview);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = {
      name,
      brand: brand.trim() === "" ? null : brand,
      categoryId,
      baseUnit,
      classification: baseUnit === "each" ? "counted" as const : "measured" as const,
      ...(image && { image }),
    };
    const creating = !editing;
    setBusy(true);
    setErrors({});
    setError("");
    setSaved("");
    try {
      let result: Awaited<ReturnType<AdminApi["createMasterProduct"]>>;
      let createData: ReturnType<typeof CreateMasterProductBody.parse> | undefined;
      if (editing?.published) {
        const parsed = EditMasterProductBody.safeParse(body);
        if (!parsed.success) {
          setErrors(fieldMessages(parsed.error.issues.map((issue) => String(issue.path[0])), strings.productInvalidFields));
          return;
        }
        result = await api.editMasterProduct(editing.id, parsed.data);
      } else {
        const parsed = CreateMasterProductBody.safeParse(body);
        if (!parsed.success) {
          setErrors(fieldMessages(parsed.error.issues.map((issue) => String(issue.path[0])), strings.productInvalidFields));
          return;
        }
        createData = parsed.data;
        result = editing
          ? await api.editMasterProduct(editing.id, parsed.data)
          : await api.createMasterProduct(parsed.data);
      }
      if (result.ok) finish(result.data);
      else {
        failed(result.code, result.fields);
        if (creating && result.code === "UNAVAILABLE") {
          const refreshed = await api.listMasterProducts();
          if (refreshed.ok) {
            setProducts(refreshed.data.products);
            const draft = refreshed.data.products.find((item) => !item.published && item.name === createData?.name && item.brand === (createData.brand ?? null));
            if (draft) setEditing(draft);
            setError(draft ? strings.productImagePending : strings.errors.UNAVAILABLE);
          }
        }
      }
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  async function changeActive(product: MasterProduct, active: boolean, reason?: string) {
    const body = EditMasterProductBody.safeParse({ active, ...(reason !== undefined && { reason }) });
    if (!body.success) {
      setErrors({ reason: strings.productInvalidFields.reason });
      return;
    }
    setSaved("");
    setBusy(true);
    setError("");
    setErrors({});
    try {
      const result = await api.editMasterProduct(product.id, body.data);
      if (result.ok) finish(result.data, active ? strings.productReactivated : strings.productDeactivated);
      else failed(result.code, result.fields);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  function deactivate(reason: string) {
    const parsed = AdminActionReason.safeParse(reason);
    if (!parsed.success) {
      setErrors({ reason: strings.productInvalidFields.reason });
      return;
    }
    if (deactivating) void changeActive(deactivating, false, parsed.data);
  }

  const query = search.trim().toLowerCase();
  const visible = products.filter((product) => `${product.name} ${product.brand ?? ""}`.toLowerCase().includes(query));

  if (packing) return <Packs api={api} product={packing} onBack={() => setPacking(null)} />;

  return <>
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-title-large font-semibold">{strings.products}</h1><p className="mt-2 text-muted">{strings.productIntro}</p></div>
      {screen === "list" && <div className="flex gap-3"><Link to="/products/import" className="flex h-10 items-center rounded-lg border border-border-strong px-4">{strings.catalogImport.title}</Link><button onClick={() => openForm(null)} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary">{strings.newProduct}</button></div>}
    </div>
    {saved && <p role="status" className="mb-4 rounded-lg bg-success-subtle p-3 text-on-success-subtle">{saved}</p>}
    {error && screen === "list" && !deactivating && <p role="alert" className="mb-4 text-danger">{error}</p>}
    {screen === "form" ? <section className="max-w-xl rounded-xl border border-border bg-surface p-6">
      <h2 className="text-body font-semibold">{editing ? strings.editProduct(editing.name) : strings.newProduct}</h2>
      <form onSubmit={(event) => void save(event)} className="mt-6 space-y-4" noValidate>
        {(["name", "brand"] as const).map((field) => <div key={field}>
          <label htmlFor={`product-${field}`} className="mb-2 block font-medium">{field === "name" ? strings.productName : strings.productBrand}</label>
          <input id={`product-${field}`} value={field === "name" ? name : brand} onChange={(event) => field === "name" ? setName(event.target.value) : setBrand(event.target.value)}
            className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />
          {errors[field] && <p role="alert" className="mt-1 text-secondary text-danger">{errors[field]}</p>}
        </div>)}
        <div><label htmlFor="product-category" className="mb-2 block font-medium">{strings.productCategory}</label>
          <select id="product-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3">
            {loaded.categories.map((category) => <option key={category.id} value={category.id} disabled={!category.effectiveActive}>
              {category.name}{category.effectiveActive ? "" : strings.productCategoryInactive}
            </option>)}
          </select>
          {errors.categoryId && <p role="alert" className="mt-1 text-secondary text-danger">{errors.categoryId}</p>}</div>
        <div><label htmlFor="product-unit" className="mb-2 block font-medium">{strings.productBaseUnit}</label>
          <select id="product-unit" value={baseUnit} onChange={(event) => setBaseUnit(event.target.value as ProductBaseUnit)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3">
            {Object.entries(strings.productUnits).map(([unit, label]) => <option key={unit} value={unit}>{label}</option>)}
          </select>
          {errors.baseUnit && <p role="alert" className="mt-1 text-secondary text-danger">{errors.baseUnit}</p>}
          {errors.classification && <p role="alert" className="mt-1 text-secondary text-danger">{errors.classification}</p>}</div>
        <div><label htmlFor="product-image" className="mb-2 block font-medium">{strings.productImage}</label>
          <p className="mb-2 text-secondary text-muted">{strings.productImageHint}</p>
          {(preview || editing?.imageUrls?.[256]) && <img src={preview || editing?.imageUrls?.[256] || ""} alt={strings.productImage} className="mb-3 h-20 w-20 rounded-lg object-cover" />}
          <input id="product-image" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void chooseImage(event)} className="block w-full text-secondary" />
          {errors.image && <p role="alert" className="mt-1 text-secondary text-danger">{errors.image}</p>}</div>
        {error && <p role="alert" className="text-danger">{error}</p>}
        <div className="flex gap-3"><button disabled={busy} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{busy ? strings.saving : strings.saveProduct}</button>
          <button type="button" disabled={busy} onClick={() => { setScreen("list"); setEditing(null); setError(""); setErrors({}); }} className="h-10 rounded-lg border border-border-strong px-4">{strings.cancel}</button></div>
      </form>
    </section> : <section className="rounded-xl border border-border bg-surface p-6">
      <label htmlFor="product-search" className="sr-only">{strings.searchProducts}</label>
      <input id="product-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={strings.searchProducts}
        className="mb-5 h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />
      {products.length === 0 ? <p className="text-muted">{strings.noProducts}</p> : visible.length === 0 ? <p className="text-muted">{strings.noProductMatches}</p> :
        <ul>{visible.map((product) => <li key={product.id} className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-4">
          <div className="flex min-w-0 items-center gap-4">
            {product.imageUrls && <img src={product.imageUrls[256]} alt="" className="h-12 w-12 rounded-lg object-cover" />}
            <div><p className="font-medium">{product.name}{product.brand && <span className="ml-2 text-muted">{product.brand}</span>}</p>
              <p className="text-secondary text-muted">{product.categoryName}{product.categoryEffectiveActive ? "" : strings.productCategoryInactive} · {strings.productUnits[product.baseUnit]}</p>
              <p className="text-secondary text-muted">{!product.published ? strings.productImageIncomplete : product.active ? strings.productActive : strings.productInactive}</p>
            </div>
          </div>
          <div className="flex gap-2">
            {product.published && <button type="button" onClick={() => setPacking(product)} className="h-10 rounded-lg border border-border-strong px-3">{strings.managePacks(product.name)}</button>}
            <button type="button" disabled={busy} onClick={() => openForm(product)} className="h-10 rounded-lg border border-border-strong px-3">{!product.published ? strings.retryProductImage(product.name) : strings.editProduct(product.name)}</button>
            {product.published && <button type="button" disabled={busy} onClick={() => product.active ? (setDeactivating(product), setErrors({}), setError("")) : void changeActive(product, true)}
              className="h-10 rounded-lg border border-border-strong px-3">{product.active ? strings.deactivateProduct : strings.reactivateProduct}</button>}
          </div>
        </li>)}</ul>}
      </section>}
    {deactivating && <ReasonDialog title={strings.deactivateProductTitle(deactivating.name)} confirmLabel={strings.deactivateProduct} danger busy={busy}
      reasonError={errors.reason} error={error} onConfirm={deactivate} onCancel={() => { setDeactivating(null); setErrors({}); setError(""); }} />}
  </>;
}
