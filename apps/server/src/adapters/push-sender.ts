/**
 * Push through Expo's push service (ADR-0001). A push only mirrors a state
 * change already recorded, so nothing waits on its delivery (CONTEXT.md).
 */
export interface PushSender {
  /**
   * Sends pushes of one app (Expo refuses a request mixing two projects) and answers, in the same order, "sent" only
   * when the service confirmed it, "dead" for a token the phone no longer holds, or "failed" for anything else, so the
   * queue tries again.
   */
  send(pushes: Push[]): Promise<PushResult[]>;
}

export type PushResult = "sent" | "dead" | "failed";

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
  };
}

/** Logs what would have been sent, for a server running without Expo. */
export function createLoggingPushSender(log: (pushes: Push[]) => void): PushSender {
  return {
    async send(pushes: Push[]) {
      log(pushes);
      return pushes.map(() => "sent" as const);
    },
  };
}

/** Expo takes at most 100 messages a request. */
const EXPO_BATCH = 100;

type ExpoTicket = { status: "ok" } | { status: "error"; details?: { error?: string } };

/** Expo's push service; `post` is swapped in tests. */
export function createExpoPushSender(
  post: (body: string) => Promise<Response> = (body) => fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body, signal: AbortSignal.timeout(10_000),
  }),
): PushSender {
  return {
    async send(pushes: Push[]) {
      const results: PushResult[] = [];
      for (let start = 0; start < pushes.length; start += EXPO_BATCH) {
        const messages = pushes.slice(start, start + EXPO_BATCH).map(({ to, title, body, data, loud }) => ({
          to, title, body, data,
          ...loud
            ? { channelId: "new-orders", sound: "new_order.wav", priority: "high", interruptionLevel: "time-sensitive" }
            : { sound: "default" },
        }));
        // A request fails only its own messages, so those already sent are not sent again. Only an "ok" ticket
        // counts as sent: an error, a missing ticket or an answer that can't be read is tried again (NOT-2).
        const tickets = await post(JSON.stringify(messages))
          .then(async (response) => response.ok ? (await response.json() as { data?: unknown }).data : undefined)
          .catch(() => undefined);
        results.push(...messages.map((_, i) => {
          const ticket = Array.isArray(tickets) ? tickets[i] as ExpoTicket | undefined : undefined;
          if (ticket?.status === "ok") return "sent" as const;
          return ticket?.status === "error" && ticket.details?.error === "DeviceNotRegistered" ? "dead" as const : "failed" as const;
        }));
      }
      return results;
    },
  };
}
