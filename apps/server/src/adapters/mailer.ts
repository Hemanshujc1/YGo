import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { NodeHttpHandler } from "@smithy/node-http-handler";

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

const MAILPIT_REQUEST_TIMEOUT_MS = 5_000;

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

export function createSesMailer(
  from: string,
  region: string,
  client: { send(command: SendEmailCommand): Promise<unknown> } = new SESv2Client({
    region,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 2_000,
      requestTimeout: 5_000,
      throwOnRequestTimeout: true,
    }),
  }),
): Mailer {
  return {
    async send(mail: Mail) {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [mail.to] },
          Content: {
            Simple: {
              Subject: { Data: mail.subject, Charset: "UTF-8" },
              Body: { Text: { Data: mail.text, Charset: "UTF-8" } },
            },
          },
        }),
      );
    },
  };
}

export function createMailpitMailer(from: string, baseUrl: string): Mailer {
  const url = new URL("/api/v1/send", baseUrl);
  return {
    async send(mail: Mail) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MAILPIT_REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            From: { Email: from },
            To: [{ Email: mail.to }],
            Subject: mail.subject,
            Text: mail.text,
          }),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw new Error("Mailpit send timed out");
        throw new Error("Mailpit send failed");
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`Mailpit send failed with HTTP ${response.status}`);
    },
  };
}
