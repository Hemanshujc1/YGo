import { accountEpoch, session } from "../api";

export function isCurrentAccount(accountId: string, epoch?: number): boolean {
  const current = session.get();
  return (epoch === undefined || epoch === accountEpoch()) && "account" in current && current.account.id === accountId;
}
