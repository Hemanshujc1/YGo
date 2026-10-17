/**
 * Push through Expo's push service (ADR-0001). A push only mirrors a state
 * change already recorded, so nothing waits on its delivery (CONTEXT.md).
 */
export interface PushSender {
  send(push: Push): Promise<void>;
}

export interface Push {
  /** An Expo push token. */
  to: string;
  title: string;
  body: string;
}

/** Records what would have been sent. */
export function createLocalPushSender(): PushSender & { sent: Push[] } {
  const sent: Push[] = [];
  return {
    sent,
    async send(push: Push) {
      sent.push(push);
    },
  };
}
