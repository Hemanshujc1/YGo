import { z } from "zod";

/** `PUT /v1/me/push-token` (#505): the phone's Expo push token, kept for the session that sent it. */
export const PushTokenBody = z.strictObject({ token: z.string().max(200).regex(/^Expo(nent)?PushToken\[[^\]]+\]$/) });
export type PushTokenBody = z.infer<typeof PushTokenBody>;

/** What a notification reports (CONTEXT.md, Notifications). Later tickets add theirs. */
export const NotificationKind = z.enum(["order_placed", "order_cancelled_by_customer", "order_accepted", "order_rejected"]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** One row of C22 or S41, in the words its push carried (NOT-1). A tap opens `orderId` when there is one. */
export const Notification = z.strictObject({
  id: z.uuid(),
  kind: NotificationKind,
  title: z.string(),
  body: z.string(),
  orderId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  read: z.boolean(),
});
export type Notification = z.infer<typeof Notification>;

/** `GET /v1/me/notifications`: the newest 50 for the calling app, newest first; `unread` lights the Home bell. */
export const NotificationsResponse = z.strictObject({ notifications: z.array(Notification), unread: z.boolean() });
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;

export const NotificationParams = z.strictObject({ id: z.uuid() });
export type NotificationParams = z.infer<typeof NotificationParams>;
