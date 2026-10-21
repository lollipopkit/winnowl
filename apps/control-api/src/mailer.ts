import { mailerFromEnv as sharedFromEnv, type MailMessage as SharedMessage } from '@reviewbot/notifications';

export type MailMessage = SharedMessage;

export type Mailer = (msg: MailMessage) => Promise<void>;

/** undefined without `SMTP_HOST`/`MAIL_FROM`; invites then fall back to manual token sharing. */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | undefined {
  return sharedFromEnv(env);
}
