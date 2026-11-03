/**
 * Push through Expo's push service (ADR-0001). A push only mirrors a state
 * change already recorded, so nothing waits on its delivery (CONTEXT.md).
 */
export interface PushSender {
  /**
   * Sends each push and answers, in the same order, "dead" for a token the phone no longer holds,
   * or "sent" otherwise. Throws when the service can't be reached, so the queue tries again.
   */
  send(pushes: Push[]): Promise<Array<"sent" | "dead">>;
}

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
      const results: Array<"sent" | "dead"> = [];
      for (let start = 0; start < pushes.length; start += EXPO_BATCH) {
        const messages = pushes.slice(start, start + EXPO_BATCH).map(({ to, title, body, data, loud }) => ({
          to, title, body, data,
          ...loud
            ? { channelId: "new-orders", sound: "new_order.wav", priority: "high", interruptionLevel: "time-sensitive" }
            : { sound: "default" },
        }));
        const response = await post(JSON.stringify(messages));
        if (!response.ok) throw new Error(`Expo push answered ${response.status}`);
        const { data: tickets } = await response.json() as { data: ExpoTicket[] };
        // Any other error drops that one push: a missed push changes nothing (NOT-2).
        results.push(...messages.map((_, i) => {
          const ticket = tickets[i];
          return ticket?.status === "error" && ticket.details?.error === "DeviceNotRegistered" ? "dead" as const : "sent" as const;
        }));
      }
      return results;
    },
  };
}
