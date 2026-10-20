import { expect, it, vi } from "vitest";

const constructors = vi.hoisted(() => ({
  client: vi.fn(),
  handler: vi.fn(),
}));

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: function MockSesClient(options: unknown) { constructors.client(options); },
  SendEmailCommand: function MockSendEmailCommand() {},
}));

vi.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: function MockNodeHttpHandler(options: unknown) { constructors.handler(options); },
}));

import { createSesMailer } from "../src/adapters/mailer";

it("bounds the default SES client request and rejects request timeouts", () => {
  createSesMailer("hello@example.com", "ap-south-1");

  expect(constructors.handler).toHaveBeenCalledWith({
    connectionTimeout: 2_000,
    requestTimeout: 5_000,
    throwOnRequestTimeout: true,
  });
  expect(constructors.client).toHaveBeenCalledWith({
    region: "ap-south-1",
    requestHandler: expect.any(Object),
  });
});
