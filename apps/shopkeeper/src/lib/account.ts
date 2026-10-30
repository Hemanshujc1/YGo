import { session } from "../api";

export function isCurrentAccount(accountId: string): boolean {
  const current = session.get();
  return "account" in current && current.account.id === accountId;
}
