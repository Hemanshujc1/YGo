/**
 * Sends a phone-number confirmation code. Sign-in by SMS is built and switched
 * off until stage two, so there is no real implementation yet (PRD ACC-10).
 */
export interface SmsSender {
  sendCode(to: string, code: string): Promise<void>;
}

/** Records each code. */
export function createLocalSmsSender(): SmsSender & { sent: { to: string; code: string }[] } {
  const sent: { to: string; code: string }[] = [];
  return {
    sent,
    async sendCode(to: string, code: string) {
      sent.push({ to, code });
    },
  };
}
