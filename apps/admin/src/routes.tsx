import { createAdminApiClient } from "@ygo/api-client";
import { CreateAdminBody, RequestCodeBody, VerifyCodeBody, type Account } from "@ygo/contracts";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  Link,
  isRouteErrorResponse,
  redirect,
  useLoaderData,
  useLocation,
  useNavigate,
  useRouteError,
  type RouteObject,
} from "react-router";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type Field = keyof CreateAdminBody;
type FieldErrors = Partial<Record<Field, string>>;

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="border-b border-border bg-surface px-8 py-5">
        <Link to="/accounts" className="text-xl font-semibold text-brand">{strings.title}</Link>
      </header>
      <main className="mx-auto max-w-5xl px-8 py-10">{children}</main>
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
      if (result.ok) void navigate("/accounts");
      else setError(strings.errors[result.code]);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <section className="mx-auto max-w-md rounded-xl border border-border bg-surface p-8">
        <h1 className="text-2xl font-semibold">{strings.signIn}</h1>
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
  const loaded = useLoaderData() as Account[];
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState(loaded);
  const [screen, setScreen] = useState<"list" | "new" | "created">("list");
  const [fields, setFields] = useState<CreateAdminBody>({ email: "", name: "", phone: "", reason: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Account | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = CreateAdminBody.safeParse(fields);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Field;
        next[field] = strings.invalidFields[field];
      }
      setErrors(next);
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
        setErrors(Object.fromEntries(result.fields.map((field) => [field, strings.invalidFields[field as Field]])));
      } else setError(strings.errors[result.code]);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const result = await api.signOut();
      void navigate("/sign-in", { state: result.ok ? undefined : { warning: strings.signOutUnconfirmed } });
    } catch {
      void navigate("/sign-in", { state: { warning: strings.signOutUnconfirmed } });
    }
  }

  return (
    <Page>
      <div className="mb-8 flex items-center justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold">{strings.accounts}</h1>
          <p className="mt-2 text-muted">{strings.accountIntro}</p>
        </div>
        <button disabled={busy} onClick={() => void signOut()} className="h-10 rounded-lg border border-border-strong px-4 text-primary">
          {busy ? strings.signingOut : strings.signOut}
        </button>
      </div>
      {screen === "list" && (
        <section className="rounded-xl border border-border bg-surface p-6">
          <div className="mb-6 flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">{strings.accounts}</h2>
            <button onClick={() => setScreen("new")} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary">
              {strings.newAccount}
            </button>
          </div>
          {accounts.length === 0 ? <p className="text-muted">{strings.noAccounts}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-xl text-left text-sm">
                <thead className="bg-sunken"><tr>
                  <th className="p-3 font-medium">{strings.name}</th><th className="p-3 font-medium">{strings.email}</th>
                  <th className="p-3 font-medium">{strings.phone}</th>
                </tr></thead>
                <tbody>{accounts.map((account) => <tr key={account.id} className="border-t border-border">
                  <td className="p-3">{account.name}</td><td className="p-3">{account.email}</td><td className="p-3">{account.phone}</td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {screen === "new" && (
        <section className="max-w-xl rounded-xl border border-border bg-surface p-6">
          <h2 className="text-lg font-semibold">{strings.newAccount}</h2>
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
                {field === "reason" && <p className="mt-1 text-sm text-muted">{strings.reasonHint}</p>}
                {errors[field] && <p role="alert" className="mt-1 text-sm text-danger">{errors[field]}</p>}
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
          <h2 className="text-lg font-semibold text-success">{strings.created}</h2>
          <p className="mt-3">{created.name} · {created.email}</p>
          <button onClick={() => { setScreen("list"); setFields({ email: "", name: "", phone: "", reason: "" }); }}
            className="mt-6 h-10 rounded-lg bg-primary px-4 font-medium text-on-primary">{strings.backToAccounts}</button>
        </section>
      )}
    </Page>
  );
}

function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return <Page><Message>{notFound ? strings.notFound : strings.failed}</Message><Link to="/accounts" className="mt-4 inline-block text-primary underline">{strings.retry}</Link></Page>;
}

export function adminRoutes(api: AdminApi): RouteObject[] {
  return [
    { path: "/", loader: () => redirect("/accounts") },
    { path: "/sign-in", element: <SignIn api={api} /> },
    {
      path: "/accounts",
      loader: async () => {
        const result = await api.listAccounts();
        if (result.ok) return result.data.accounts;
        if (result.code === "UNAUTHENTICATED" || result.code === "FORBIDDEN") return redirect("/sign-in");
        throw new Error(result.code);
      },
      element: <Accounts api={api} />,
      hydrateFallbackElement: <Page>{strings.loading}</Page>,
      errorElement: <RouteError />,
    },
    { path: "*", element: <Page><Message>{strings.notFound}</Message></Page> },
  ];
}
