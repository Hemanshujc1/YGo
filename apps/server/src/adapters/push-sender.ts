/**
 * Push through Expo's push service (ADR-0001). A push only mirrors a state
 * change already recorded, so nothing waits on its delivery (CONTEXT.md).
 */
export interface PushSender {
  /**
   * Sends pushes of one app (Expo refuses a request mixing two projects) and answers, in the same order, "sent" (or
   * a ticket to read the receipt of later, #509) only when the service confirmed it, "dead" for a token the phone no
   * longer holds, or "failed" for anything else, so the queue tries again.
   */
  send(pushes: Push[]): Promise<PushResult[]>;
  /**
   * Reads the receipts of tickets of one app, some minutes after sending. A ticket missing from the answer has no
   * receipt yet or its request failed: ask again later.
   */
  receipts(ticketIds: string[]): Promise<Map<string, ReceiptResult>>;
}

export type PushResult = "sent" | "dead" | "failed" | { ticketId: string };
/** "dead": the phone no longer holds the token; "other": delivery failed for a reason that says nothing of the token. */
export type ReceiptResult = "ok" | "dead" | "other";

export interface Push {
  /** An Expo push token. */
  to: string;
  title: string;
  body: string;
  /** What a tap opens (#506, #507). */
  data: { notificationId: string; orderId: string | null };
  /** The new-order alarm (NOT-3): the "new-orders" channel and its tone, which the Shopkeeper app sets up (#507). */
  loud: boolean;
}

/** Records what would have been sent. */
export function createLocalPushSender(): PushSender & { sent: Push[] } {
  const sent: Push[] = [];
  return {
    sent,
    async send(pushes: Push[]) {
      sent.push(...pushes);
      return pushes.map(() => "sent" as const);
    },
    async receipts() {
      return new Map();
    },
  };
}

/** Logs what would have been sent, for a server running without Expo. */
export function createLoggingPushSender(log: (pushes: Push[]) => void): PushSender {
  return {
    async send(pushes: Push[]) {
      log(pushes);
      return pushes.map(() => "sent" as const);
    },
    async receipts() {
      return new Map();
    },
  };
}

/** Expo takes at most 100 messages a request, and 1000 receipt ids. */
const EXPO_BATCH = 100;
const EXPO_RECEIPT_BATCH = 1000;

type ExpoTicket = { status: "ok"; id?: string } | { status: "error"; details?: { error?: string } };

const postToExpo = (path: string) => (body: string) => fetch(`https://exp.host/--/api/v2/push/${path}`, {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body, signal: AbortSignal.timeout(10_000),
});

/** Expo's push service; `post` and `postReceipts` are swapped in tests. */
export function createExpoPushSender(
  post: (body: string) => Promise<Response> = postToExpo("send"),
  postReceipts: (body: string) => Promise<Response> = postToExpo("getReceipts"),
): PushSender {
  return {
    async send(pushes: Push[]) {
      const results: PushResult[] = [];
      for (let start = 0; start < pushes.length; start += EXPO_BATCH) {
        const messages = pushes.slice(start, start + EXPO_BATCH).map(({ to, title, body, data, loud }) => ({
          to, title, body,
          // `loud` in the data too: the open app reads it to ring for this push only (owner's answer 9 on #507).
          ...loud
            ? { data: { ...data, loud: true }, channelId: "new-orders", sound: "new_order.wav", priority: "high", interruptionLevel: "time-sensitive" }
            : { data, sound: "default" },
        }));
        // A request fails only its own messages, so those already sent are not sent again. Only an "ok" ticket
        // counts as sent: an error, a missing ticket or an answer that can't be read is tried again (NOT-2).
        const tickets = await post(JSON.stringify(messages))
          .then(async (response) => response.ok ? (await response.json() as { data?: unknown }).data : undefined)
          .catch(() => undefined);
        results.push(...messages.map((_, i) => {
          const ticket = Array.isArray(tickets) ? tickets[i] as ExpoTicket | undefined : undefined;
          if (ticket?.status === "ok") return ticket.id ? { ticketId: ticket.id } : "sent" as const;
          return ticket?.status === "error" && ticket.details?.error === "DeviceNotRegistered" ? "dead" as const : "failed" as const;
        }));
      }
      return results;
    },
    async receipts(ticketIds: string[]) {
      const found = new Map<string, ReceiptResult>();
      for (let start = 0; start < ticketIds.length; start += EXPO_RECEIPT_BATCH) {
        const ids = ticketIds.slice(start, start + EXPO_RECEIPT_BATCH);
        // A failed request leaves its ids out, so they are asked for again.
        const data = await postReceipts(JSON.stringify({ ids }))
          .then(async (response) => response.ok ? (await response.json() as { data?: unknown }).data : undefined)
          .catch(() => undefined);
        if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
        for (const id of ids) {
          const receipt = (data as Record<string, ExpoTicket | undefined>)[id];
          if (receipt?.status === "ok") found.set(id, "ok");
          else if (receipt?.status === "error") found.set(id, receipt.details?.error === "DeviceNotRegistered" ? "dead" : "other");
        }
      }
      return found;
    },
  };
}
