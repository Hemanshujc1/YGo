import type { RateCardKey, RateCardValues as Values } from "@ygo/contracts";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { strings } from "../strings";

export type FieldIssue = { path: string; message: string };
type Rule = "commission" | "deliveryFee" | "smallCartFee" | "pickup" | "counterBillCharge";

const without = (record: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
const options = { formulas: ["fixed", "percentage", "fixed_plus_percentage", "higher_of", "lower_of"], bases: ["before_shop_discount", "after_shop_discount"] };

/** Turns contract issues into the field messages the inputs below show; `prefix` strips a wrapper such as `draft.values.`. */
export function rateCardIssues(issues: Array<{ path: PropertyKey[] }>, prefix = ""): FieldIssue[] {
  return issues.map((item) => {
    const path = item.path.join(".").slice(prefix.length);
    return { path, message: (strings.rateCardIssueMessages as Record<string, string>)[path] ?? strings.rateCardIssueMessages.default };
  });
}

/**
 * The rate-card value inputs, in the editor's order: A03's editor shows every key, A05's draft only the
 * ones a delivered quote reads. Empty means inherit; nothing here saves anything.
 */
export function RateCardFields({ values, onChange, issues, keys }: { values: Values; onChange: Dispatch<SetStateAction<Values>>; issues: FieldIssue[]; keys?: RateCardKey[] }) {
  const shown = (key: RateCardKey) => !keys || keys.includes(key);

  function changeScalar(key: RateCardKey, raw: string) {
    onChange((current) => {
      const next = { ...current };
      if (!raw) return without(next, key) as Values;
      else (next as Record<string, unknown>)[key] = key === "statementGraceDays" ? Number(raw) : raw;
      return next;
    });
  }

  function changeNested(key: Rule, field: string, raw: string | boolean) {
    onChange((current) => {
      const next = { ...current } as Record<string, unknown>;
      let rule = { ...((current[key] ?? {}) as Record<string, unknown>) };
      if (key === "commission" && field === "formula") {
        rule.formula = raw;
        if (raw === "fixed") rule.percentage = null;
        else if (raw === "percentage") rule.fixedAmount = null;
      } else if (key === "deliveryFee" || key === "smallCartFee") {
        const split = { ...((rule.split ?? {}) as Record<string, unknown>) };
        if (field.startsWith("split.")) {
          const splitKey = field.slice("split.".length);
          if (raw === "") rule.split = without(split, splitKey); else { split[splitKey] = raw; rule.split = split; }
        } else if (raw === "") rule = without(rule, field); else rule[field] = raw;
      } else if (raw === "") rule = without(rule, field); else rule[field] = raw;
      next[key] = rule;
      return next as Values;
    });
  }

  function removeRule(key: Rule) {
    onChange((current) => without(current, key) as Values);
  }

  function issue(path: string) { return issues.find((item) => item.path === path)?.message; }
  function scalarField(key: RateCardKey, kind: "money" | "percentage" | "integer" = "money") {
    if (!shown(key)) return null;
    const value = values[key];
    return <label className="block font-medium">{strings.rateCardFields[key]}
      <div className="mt-1 flex h-10 items-center rounded-lg border border-border-strong bg-surface"><span className="px-3 text-muted">{kind === "money" ? strings.rateCardMoneyPrefix : kind === "percentage" ? strings.rateCardPercentagePrefix : strings.rateCardGraceDaysUnit}</span><input aria-label={strings.rateCardFields[key]} inputMode={kind === "integer" ? "numeric" : "decimal"} value={value === undefined ? "" : String(value)} onChange={(event) => changeScalar(key, event.target.value)} className="h-full min-w-0 flex-1 rounded-r-lg bg-transparent px-2" /></div>
      {issue(key) && <span role="alert" className="text-sm text-danger">{issue(key)}</span>}
    </label>;
  }
  function nestedField(key: Rule, field: string, label: string, kind: "money" | "percentage" | "text" | "boolean" = "money", inputOptions?: string[]) {
    const source = values[key] as Record<string, unknown> | undefined;
    const path = `${key}.${field}`;
    const current = field.startsWith("split.") ? ((source?.split as Record<string, unknown> | undefined)?.[field.slice(6)]) : source?.[field];
    if (kind === "boolean") return <label className="flex min-h-10 items-center gap-2"><input className="h-10 w-10" type="checkbox" checked={current === true} onChange={(event) => changeNested(key, field, event.target.checked)} />{label}</label>;
    if (inputOptions) return <label className="block font-medium">{label}<select aria-label={label} value={String(current ?? "")} onChange={(event) => changeNested(key, field, event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-border-strong bg-surface px-3"><option value="">{strings.rateCardSelect}</option>{inputOptions.map((option) => <option key={option} value={option}>{(strings.rateCardOptions as Record<string, string>)[option] ?? option}</option>)}</select>{issue(path) && <span role="alert" className="text-sm text-danger">{issue(path)}</span>}</label>;
    const commissionFormula = values.commission?.formula;
    const formulaInactive = (field === "fixedAmount" && commissionFormula === "percentage") || (field === "percentage" && commissionFormula === "fixed");
    return <label className="block font-medium">{label}<div className="mt-1 flex h-10 items-center rounded-lg border border-border-strong bg-surface"><span className="px-3 text-muted">{kind === "money" ? strings.rateCardMoneyPrefix : kind === "percentage" ? strings.rateCardPercentagePrefix : ""}</span><input aria-label={label} disabled={formulaInactive} inputMode={kind === "text" ? "text" : "decimal"} value={formulaInactive ? "" : String(current ?? "")} onChange={(event) => changeNested(key, field, event.target.value)} className="h-full min-w-0 flex-1 rounded-r-lg bg-transparent px-2 disabled:opacity-50" /></div>{issue(path) && <span role="alert" className="text-sm text-danger">{issue(path)}</span>}</label>;
  }
  function ruleSection(key: Rule, children: ReactNode) {
    if (!shown(key)) return null;
    const enabled = values[key] !== undefined;
    return <section className="rounded-xl border border-border bg-surface p-5"><div className="flex items-center justify-between"><h3 className="font-semibold">{strings.rateCardFields[key]}</h3>{enabled ? <button type="button" onClick={() => removeRule(key)} className="text-primary underline">{strings.rateCardClearRule}</button> : <button type="button" onClick={() => onChange((current) => ({ ...current, [key]: key === "smallCartFee" || key === "pickup" || key === "counterBillCharge" ? { enabled: false } : {} } as Values))} className="text-primary underline">{strings.rateCardConfigure}</button>}</div>{enabled && <div className="mt-4 grid gap-4 md:grid-cols-2">{children}</div>}{!enabled && <p className="mt-2 text-muted">{strings.rateCardEmpty}</p>}</section>;
  }

  return <>
    {ruleSection("commission", <>{nestedField("commission", "formula", strings.rateCardFormula, "text", options.formulas)}{nestedField("commission", "fixedAmount", strings.rateCardFixedAmount)}{nestedField("commission", "percentage", strings.rateCardCommissionPercentage, "percentage")}{nestedField("commission", "minimum", strings.rateCardMinimum)}{nestedField("commission", "maximum", strings.rateCardMaximum)}{nestedField("commission", "base", strings.rateCardCommissionBase, "text", options.bases)}</>)}
    {ruleSection("deliveryFee", <>{nestedField("deliveryFee", "amount", strings.rateCardDeliveryAmount)}{nestedField("deliveryFee", "split.platformPercentage", strings.rateCardPlatformSplit, "percentage")}{nestedField("deliveryFee", "split.shopPercentage", strings.rateCardShopSplit, "percentage")}</>)}
    {ruleSection("smallCartFee", <>{nestedField("smallCartFee", "enabled", strings.rateCardEnabled, "boolean")}{nestedField("smallCartFee", "threshold", strings.rateCardThreshold)}{nestedField("smallCartFee", "amount", strings.rateCardFeeAmount)}{nestedField("smallCartFee", "cap", strings.rateCardCap)}{nestedField("smallCartFee", "split.platformPercentage", strings.rateCardPlatformSplit, "percentage")}{nestedField("smallCartFee", "split.shopPercentage", strings.rateCardShopSplit, "percentage")}</>)}
    {scalarField("deliveredContributionFloor")}{scalarField("minimumCart")}
    {ruleSection("pickup", <>{nestedField("pickup", "enabled", strings.rateCardEnabled, "boolean")}{nestedField("pickup", "customerFee", strings.rateCardCustomerFee)}{nestedField("pickup", "shopFee", strings.rateCardShopFee)}{nestedField("pickup", "cap", strings.rateCardCap)}{nestedField("pickup", "contributionFloor", strings.rateCardPickupFloor)}</>)}
    {ruleSection("counterBillCharge", <>{nestedField("counterBillCharge", "amount", strings.rateCardCounterCharge)}</>)}
    {scalarField("statementGraceDays", "integer")}{scalarField("balanceLimit")}{scalarField("bargainMinimumCommission")}{scalarField("maximumShopDiscountPercentage", "percentage")}
  </>;
}
