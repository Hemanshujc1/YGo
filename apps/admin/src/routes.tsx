import { createAdminApiClient, type ApiResult } from "@ygo/api-client";
import { CreateAdminBody, RequestCodeBody, VerifyCodeBody, type AdminAccount, type AdminRole } from "@ygo/contracts";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  Link,
  isRouteErrorResponse,
  redirect,
  type LoaderFunction,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
  useRouteError,
  type RouteObject,
} from "react-router";
import { Areas } from "./areas";
import { Categories } from "./categories";
import { CatalogImport } from "./catalog-import";
import { Products } from "./products";
import { ShopApplications, ShopApplicationReview } from "./shop-applications";
import { adminTheme, ThemePicker } from "./theme";
import { fieldMessages } from "./lib/field-messages";
import { strings } from "./strings";
import { Waitlist } from "./waitlist";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type Field = keyof CreateAdminBody;
type FieldErrors = Partial<Record<Field, string>>;

/**
 * Reads the role (asked once per sign-in), then runs the Admin's loader; an
 * Area Manager gets theirs, by default Applications (#343). Checked first
 * because a 403 from an Admin-only route would sign them out.
 */
function byRole(api: AdminApi, admin: LoaderFunction, areaManager: LoaderFunction = () => redirect("/applications")): LoaderFunction {
  return async (args) => {
    const role = await api.role();
    if (role.ok) return role.data === "admin" ? admin(args) : areaManager(args);
    if (role.code === "UNAUTHENTICATED" || role.code === "FORBIDDEN") return redirect("/sign-in");
    throw new Error(role.code);
  };
}

function Page({ children, protectedArea = false, api }: { children: ReactNode; protectedArea?: boolean; api?: AdminApi }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const role = api?.currentRole() ?? null;
  const nav = role === "admin" ? [
    { path: "/accounts", label: strings.accounts },
    { path: "/categories", label: strings.categories },
    { path: "/products", label: strings.products },
    { path: "/areas", label: strings.areas },
    { path: "/applications", label: strings.applications },
    { path: "/waitlist", label: strings.waitlist },
  ] : role === "area_manager" ? [{ path: "/applications", label: strings.applications }] : [];

  async function signOut() {
    if (!api) return;
    setSigningOut(true);
    try {
      const result = await api.signOut();
      void navigate("/sign-in", { state: result.ok ? undefined : { warning: strings.signOutUnconfirmed } });
    } catch {
      void navigate("/sign-in", { state: { warning: strings.signOutUnconfirmed } });
    }
  }

  return (
    <div className="min-h-screen bg-bg font-sans text-secondary text-text">
      <header className="border-b border-border bg-surface px-8 py-5">
        <div className="flex items-center justify-between gap-4">
          <Link to="/" className="text-title font-semibold text-brand">{role === "area_manager" ? strings.areaManagerTitle : protectedArea && !role ? strings.brand : strings.title}</Link>
          {protectedArea && api && <div className="flex items-center gap-4">
            <ThemePicker api={api} />
            <button disabled={signingOut} onClick={() => void signOut()} className="h-10 rounded-lg border border-border-strong px-4 text-primary">
              {signingOut ? strings.signingOut : strings.signOut}
            </button>
          </div>}
        </div>
      </header>
      <div className={protectedArea ? "flex" : ""}>
        {protectedArea && (
          <aside className="w-56 shrink-0 border-r border-border bg-surface px-4 py-8">
            <nav aria-label={strings.navigation}>
              {nav.map(({ path, label }, index) => <Link key={path} to={path} aria-current={(location.pathname === path || location.pathname.startsWith(`${path}/`)) ? "page" : undefined}
                className={`${index ? "mt-2 " : ""}block rounded-lg p-3 font-medium ${(location.pathname === path || location.pathname.startsWith(`${path}/`)) ? "bg-primary-subtle text-on-primary-subtle" : "text-muted"}`}>
                {label}
              </Link>)}
            </nav>
          </aside>
        )}
        <main className="mx-auto min-w-0 max-w-5xl flex-1 px-8 py-10">
          {protectedArea && role === "area_manager" && <p className="mb-8 rounded-lg bg-info-subtle p-3 text-on-info-subtle">{strings.areaManagerScope}</p>}
          {children}
        </main>
      </div>
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">{children}</p>;
}

function SignIn({ api }: { api: AdminApi }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function requestCode() {
    const parsed = RequestCodeBody.safeParse({ email });
    if (!parsed.success) return setError(strings.invalidEmail);
    setBusy(true);
    setError("");
    try {
      const result = await api.requestCode(parsed.data);
      if (result.ok) {
        setEmail(parsed.data.email);
        setStage("code");
      } else setError(strings.errors[result.code]);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = VerifyCodeBody.safeParse({ email, code });
    if (!parsed.success) return setError(strings.invalidCode);
    setBusy(true);
    setError("");
    try {
      const result = await api.verifyCode(parsed.data);
      if (result.ok) {
        adminTheme(api).account(result.data);
        void navigate("/");
      } else setError(strings.errors[result.code]);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <section className="mx-auto max-w-md rounded-xl border border-border bg-surface p-8">
        <h1 className="text-title-large font-semibold">{strings.signIn}</h1>
        {location.state?.warning && <Message>{location.state.warning}</Message>}
        {stage === "email" ? (
          <form onSubmit={(event) => { event.preventDefault(); void requestCode(); }} className="mt-6 space-y-5" noValidate>
            <p className="text-muted">{strings.signInIntro}</p>
            <label className="block font-medium" htmlFor="email">{strings.email}</label>
            <input id="email" name="email" type="email" autoComplete="email" required value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />
            {error && <Message>{error}</Message>}
            <button disabled={busy} className="h-10 w-full rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">
              {busy ? strings.sending : strings.sendCode}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="mt-6 space-y-5" noValidate>
            <p className="text-muted">{strings.codeSent}</p>
            <label className="block font-medium" htmlFor="code">{strings.code}</label>
            <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required
              value={code} onChange={(event) => setCode(event.target.value)}
              className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3 tabular-nums" />
            {error && <Message>{error}</Message>}
            <button disabled={busy} className="h-10 w-full rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">
              {busy ? strings.signingIn : strings.verify}
            </button>
            <button type="button" onClick={() => { setStage("email"); setCode(""); setError(""); }}
              className="block text-primary underline">{strings.differentEmail}</button>
            <button type="button" disabled={busy} onClick={() => void requestCode()}
              className="block text-primary underline disabled:opacity-60">{strings.resend}</button>
          </form>
        )}
      </section>
    </Page>
  );
}

function Accounts({ api }: { api: AdminApi }) {
  const loaded = useLoaderData() as AdminAccount[];
  const [accounts, setAccounts] = useState(loaded);
  const [screen, setScreen] = useState<"list" | "new" | "created">("list");
  const blank = { email: "", name: "", phone: "", role: undefined, reason: "" };
  const [fields, setFields] = useState<Omit<CreateAdminBody, "role"> & { role: AdminRole | undefined }>(blank);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<AdminAccount | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = CreateAdminBody.safeParse(fields);
    if (!parsed.success) {
      setErrors(fieldMessages(parsed.error.issues.map((issue) => String(issue.path[0])), strings.invalidFields));
      return;
    }
    setBusy(true);
    setErrors({});
    setError("");
    try {
      const result = await api.createAccount(parsed.data);
      if (result.ok) {
        setAccounts((current) => [...current, result.data].sort((a, b) => a.email.localeCompare(b.email)));
        setCreated(result.data);
        setScreen("created");
      } else if (result.code === "EMAIL_IN_USE") setErrors({ email: strings.errors.EMAIL_IN_USE });
      else if (result.code === "PHONE_IN_USE") setErrors({ phone: strings.errors.PHONE_IN_USE });
      else if (result.code === "VALIDATION_FAILED" && result.fields) {
        setErrors(fieldMessages(result.fields, strings.invalidFields));
      } else setError(strings.errors[result.code]);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page protectedArea api={api}>
      <div className="mb-8 flex items-center justify-between gap-6">
        <div>
          <h1 className="text-title-large font-semibold">{strings.accounts}</h1>
          <p className="mt-2 text-muted">{strings.accountIntro}</p>
        </div>
      </div>
      {screen === "list" && (
        <section className="rounded-xl border border-border bg-surface p-6">
          <div className="mb-6 flex items-center justify-between gap-4">
            <h2 className="text-body font-semibold">{strings.accounts}</h2>
            <button onClick={() => setScreen("new")} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary">
              {strings.newAccount}
            </button>
          </div>
          {accounts.length === 0 ? <p className="text-muted">{strings.noAccounts}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-xl text-left">
                <thead className="bg-sunken"><tr>
                  <th className="p-3 font-medium">{strings.name}</th><th className="p-3 font-medium">{strings.email}</th>
                  <th className="p-3 font-medium">{strings.phone}</th><th className="p-3 font-medium">{strings.role}</th>
                </tr></thead>
                <tbody>{accounts.map((account) => <tr key={account.id} className="border-t border-border">
                  <td className="p-3">{account.name}</td><td className="p-3">{account.email}</td>
                  <td className="p-3 tabular-nums">{account.phone ? `${account.phone.slice(-10, -5)} ${account.phone.slice(-5)}` : strings.noPhone}</td>
                  <td className="p-3">{strings.roles[account.role]}</td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {screen === "new" && (
        <section className="max-w-xl rounded-xl border border-border bg-surface p-6">
          <h2 className="text-body font-semibold">{strings.newAccount}</h2>
          <form onSubmit={create} className="mt-6 space-y-4" noValidate>
            {(["email", "name", "phone", "reason"] as const).map((field) => (
              <div key={field}>
                <label htmlFor={field} className="mb-2 block font-medium">{strings[field]}</label>
                {field === "reason" ? (
                  <textarea id={field} required value={fields[field]} onChange={(event) => setFields({ ...fields, [field]: event.target.value })}
                    className="min-h-24 w-full rounded-lg border border-border-strong bg-surface p-3" />
                ) : (
                  <input id={field} required type={field === "email" ? "email" : field === "phone" ? "tel" : "text"}
                    autoComplete={field === "name" ? "name" : "off"} value={fields[field]}
                    onChange={(event) => setFields({ ...fields, [field]: event.target.value })}
                    className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />
                )}
                {field === "reason" && <p className="mt-1 text-secondary text-muted">{strings.reasonHint}</p>}
                {errors[field] && <p role="alert" className="mt-1 text-secondary text-danger">{errors[field]}</p>}
                {field === "phone" && <fieldset className="mt-4" aria-invalid={Boolean(errors.role)} aria-describedby={errors.role ? "role-error" : undefined}>
                  <legend className="mb-2 font-medium">{strings.role}</legend>
                  <div className="flex gap-6">
                    {(["admin", "area_manager"] as const).map((role) => <label key={role} className="flex items-center gap-2">
                      <input type="radio" name="role" checked={fields.role === role} onChange={() => setFields({ ...fields, role })} />
                      {strings.roles[role]}
                    </label>)}
                  </div>
                  {errors.role && <p id="role-error" role="alert" className="mt-1 text-secondary text-danger">{errors.role}</p>}
                </fieldset>}
              </div>
            ))}
            {error && <Message>{error}</Message>}
            <div className="flex gap-3">
              <button disabled={busy} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">
                {busy ? strings.creating : strings.create}
              </button>
              <button type="button" disabled={busy} onClick={() => { setScreen("list"); setError(""); setErrors({}); }}
                className="h-10 rounded-lg border border-border-strong px-4">{strings.cancel}</button>
            </div>
          </form>
        </section>
      )}
      {screen === "created" && created && (
        <section className="max-w-xl rounded-xl border border-border bg-surface p-6">
          <h2 className="text-body font-semibold text-success">{strings.created}</h2>
          <p className="mt-3">{created.name} · {created.email}</p>
          <button onClick={() => { setScreen("list"); setFields(blank); }}
            className="mt-6 h-10 rounded-lg bg-primary px-4 font-medium text-on-primary">{strings.backToAccounts}</button>
        </section>
      )}
    </Page>
  );
}

function RouteError({ api }: { api?: AdminApi }) {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return <Page protectedArea api={api}><Message>{notFound ? strings.notFound : strings.failed}</Message>
    <button onClick={() => void revalidator.revalidate()} className="mt-4 h-10 rounded-lg border border-border-strong px-4 text-primary">{strings.retry}</button>
  </Page>;
}

function listLoader<T, List>(load: () => Promise<ApiResult<T>>, select: (data: T) => List) {
  return async () => {
    const result = await load();
    if (result.ok) return select(result.data);
    if (result.code === "UNAUTHENTICATED" || result.code === "FORBIDDEN") return redirect("/sign-in");
    throw new Error(result.code);
  };
}

type GuardedRoute = Omit<RouteObject, "loader" | "children" | "index"> & { loader?: LoaderFunction; areaManager?: LoaderFunction };

export function adminRoutes(api: AdminApi): RouteObject[] {
  // Every signed-in page goes through this, so none can skip the role check (#343): Admin-only unless it names an `areaManager` loader.
  const guarded = ({ loader = () => null, areaManager, ...route }: GuardedRoute): RouteObject =>
    ({ ...route, loader: byRole(api, loader, areaManager) });
  const applicationsLoader = listLoader(() => api.listShopApplications(), (data) => data.applications);
  const applicationLoader: LoaderFunction = async ({ params }) => {
    const id = params.id;
    if (!id) throw new Error(strings.notFound);
    const result = await api.getShopApplication(id);
    if (result.ok) return result.data;
    if (result.code === "UNAUTHENTICATED" || result.code === "FORBIDDEN") return redirect("/sign-in");
    throw new Error(result.code);
  };

  return [
    guarded({ path: "/", loader: () => redirect("/accounts") }),
    { path: "/sign-in", element: <SignIn api={api} /> },
    guarded({
      path: "/accounts",
      loader: listLoader(() => api.listAccounts(), (data) => data.accounts),
      element: <Accounts api={api} />,
      hydrateFallbackElement: <Page>{strings.loading}</Page>,
      errorElement: <RouteError api={api} />,
    }),
    guarded({
      path: "/categories",
      loader: listLoader(() => api.listCategories(), (data) => data.categories),
      element: <Page protectedArea api={api}><Categories api={api} /></Page>,
      hydrateFallbackElement: <Page protectedArea api={api}>{strings.categoriesLoading}</Page>,
      errorElement: <RouteError api={api} />,
    }),
    guarded({
      path: "/products/import",
      element: <Page protectedArea api={api}><CatalogImport api={api} /></Page>,
      hydrateFallbackElement: <Page protectedArea api={api}>{strings.checking}</Page>,
      errorElement: <RouteError api={api} />,
    }),
    guarded({
      path: "/products",
      loader: async () => {
        const [products, categories] = await Promise.all([api.listMasterProducts(), api.listCategories()]);
        if (!products.ok || !categories.ok) {
          if ((!products.ok && (products.code === "UNAUTHENTICATED" || products.code === "FORBIDDEN")) ||
            (!categories.ok && (categories.code === "UNAUTHENTICATED" || categories.code === "FORBIDDEN"))) return redirect("/sign-in");
          throw new Error(strings.failed);
        }
        return { products: products.data.products, categories: categories.data.categories };
      },
      element: <Page protectedArea api={api}><Products api={api} /></Page>,
      hydrateFallbackElement: <Page protectedArea api={api}>{strings.productsLoading}</Page>,
      errorElement: <RouteError api={api} />,
    }),
    guarded({
      path: "/areas",
      loader: listLoader(() => api.listAreas(), (data) => data.areas),
      element: <Page protectedArea api={api}><Areas api={api} /></Page>,
      hydrateFallbackElement: <Page protectedArea api={api}>{strings.areasLoading}</Page>,
      errorElement: <RouteError api={api} />,
    }),
    // An Area Manager uses A06 and A07 too; the server shows them only their assigned shops (#299).
    guarded({
      path: "/applications",
      loader: applicationsLoader,
      areaManager: applicationsLoader,
      element: <Page protectedArea api={api}><ShopApplications api={api} /></Page>,
      hydrateFallbackElement: <Page protectedArea api={api}>{strings.applicationsLoading}</Page>,
      errorElement: <RouteError api={api} />,
    }),
    guarded({
      path: "/applications/:id",
      loader: applicationLoader,
      areaManager: applicationLoader,
      element: <Page protectedArea api={api}><ShopApplicationReview api={api} /></Page>,
      hydrateFallbackElement: <Page protectedArea api={api}>{strings.applicationsLoading}</Page>,
      errorElement: <RouteError api={api} />,
    }),
    guarded({
      path: "/waitlist",
      loader: listLoader(() => api.listWaitlist(), (data) => data.entries),
      element: <Page protectedArea api={api}><Waitlist /></Page>,
      hydrateFallbackElement: <Page protectedArea api={api}>{strings.waitlistLoading}</Page>,
      errorElement: <RouteError api={api} />,
    }),
    { path: "*", element: <Page><Message>{strings.notFound}</Message></Page> },
  ];
}
