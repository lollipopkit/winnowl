/**
 * A notification always belongs to one tenant and is only read/written in that tenant's context.
 * Cross-tenant information arrives via `cross_tenant_events`, so no RLS bypass is needed.
 */
export {
  createNotification,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  pendingEmailNotifications,
  claimPendingEmailNotifications,
  renewNotificationEmailClaim,
  markNotificationEmailed,
  releaseNotificationEmailClaim,
  notificationRecipients,
} from './store.js';
export type {
  Notification,
  NotificationKind,
  CreateNotificationInput,
  ListNotificationsOptions,
} from './store.js';

export { assertMailFrom, createSmtpMailer, mailerFromEnv, renderNotificationEmail } from './mailer.js';
export type { Mailer, MailMessage, SmtpMailerConfig } from './mailer.js';
