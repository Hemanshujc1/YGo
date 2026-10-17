/**
 * The only email the product sends is about access to the account: the sign-in
 * code, the deletion-request code and the changed-email notice (PRD NOT-1).
 */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Keeps every mail it is given, for the test to read. */
export function createLocalMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return {
    sent,
    async send(mail: Mail) {
      sent.push(mail);
    },
  };
}
