import type { ApiResult } from "@ygo/api-client";
import { ThemeChoice, type Account, type SetThemeBody } from "@ygo/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { strings } from "./strings";

/** Also read by the script in index.html, which applies the theme before the page draws. */
const key = "ygo-admin-theme";
const themes: ThemeChoice[] = ["system", "light", "dark"];

type ThemeApi = {
  me(): Promise<ApiResult<Account>>;
  setTheme(body: SetThemeBody): Promise<ApiResult<Account>>;
};
type ThemeView = { choice: ThemeChoice; saving: boolean };

/** This browser's copy, for the next page load and the sign-in page. */
function saved(): ThemeChoice {
  try {
    const parsed = ThemeChoice.safeParse(localStorage.getItem(key));
    return parsed.success ? parsed.data : "system";
  } catch {
    return "system";
  }
}

function keep(choice: ThemeChoice) {
  try {
    localStorage.setItem(key, choice);
  } catch {
    // Storage blocked: the theme still applies until the page reloads.
  }
  // `@ygo/tokens` reads the attribute; without it the system theme decides.
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

/**
 * The theme Admin shows (#263). The account's value wins once the server
 * answers; a choice applies at once, and a failed save puts the old one back.
 * One save runs at a time, and nothing retries by itself.
 */
function createAdminTheme(api: ThemeApi) {
  let shown: ThemeView = { choice: saved(), saving: false };
  let saving: Promise<boolean> | null = null;
  let loading: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function show(next: ThemeView) {
    if (next.choice !== shown.choice) keep(next.choice);
    shown = next;
    for (const listener of listeners) listener();
  }

  async function save(choice: ThemeChoice): Promise<boolean> {
    const before = shown.choice;
    show({ choice, saving: true });
    let answer: ApiResult<Account> | null = null;
    try {
      answer = await api.setTheme({ theme: choice });
    } catch {
      // No answer: the same as a refusal.
    }
    saving = null;
    show({ choice: answer?.ok ? answer.data.theme : before, saving: false });
    return answer?.ok ?? false;
  }

  const theme = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    view: () => shown,
    /** An account from the server. During a save, the save's own answer is newer. */
    account(account: Account) {
      if (!saving) show({ choice: account.theme, saving: false });
    },
    /** Once per page load, from the signed-in pages: the account's theme wins. */
    load() {
      loading ??= api.me().then(
        (answer) => { if (answer.ok) theme.account(answer.data); },
        () => undefined,
      );
    },
    /** Resolves false, with the old theme back, when the save fails. */
    choose(choice: ThemeChoice): Promise<boolean> {
      saving ??= save(choice);
      return saving;
    },
  };
  return theme;
}

export type AdminTheme = ReturnType<typeof createAdminTheme>;

// One per API client, so each test's client starts fresh.
const byApi = new WeakMap<ThemeApi, AdminTheme>();

export function adminTheme(api: ThemeApi): AdminTheme {
  let theme = byApi.get(api);
  if (!theme) {
    theme = createAdminTheme(api);
    byApi.set(api, theme);
  }
  return theme;
}

/** System / Light / Dark in the header of the signed-in pages. */
export function ThemePicker({ api }: { api: ThemeApi }) {
  const theme = adminTheme(api);
  const { choice, saving } = useSyncExternalStore(theme.subscribe, theme.view);
  const [failed, setFailed] = useState(false);

  useEffect(() => theme.load(), [theme]);

  async function choose(next: ThemeChoice) {
    setFailed(false);
    setFailed(!(await theme.choose(next)));
  }

  return (
    <div className="flex items-center gap-3">
      {failed && <p role="alert" className="text-secondary text-danger">{strings.themeNotSaved}</p>}
      <div role="radiogroup" aria-label={strings.theme} aria-busy={saving}
        className="flex overflow-hidden rounded-lg border border-border-strong">
        {themes.map((option, index) => (
          <button key={option} type="button" role="radio" aria-checked={choice === option} disabled={saving}
            onClick={() => { if (option !== choice) void choose(option); }}
            className={`h-10 px-3 font-medium ${index ? "border-l border-border " : ""}${
              choice === option ? "bg-primary-subtle text-on-primary-subtle" : "bg-surface text-text"}`}>
            {strings.themes[option]}
          </button>
        ))}
      </div>
    </div>
  );
}
