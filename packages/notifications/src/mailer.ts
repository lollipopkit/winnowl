import { createTransport } from 'nodemailer';

/** Shared SMTP transport; callers own their content and i18n. */

export interface MailMessage {
  to: string | string[];
  /** Blind-copy recipients when the visible To header must not disclose addresses. */
  bcc?: string | string[];
  subject: string;
  text: string;
  /** Stable across retries so SMTP/downstream can deduplicate. */
  messageId?: string;
}

export type Mailer = (msg: MailMessage) => Promise<void>;

export interface SmtpMailerConfig {
  host: string;
  port: number;
  /** Implicit TLS (usually 465); when false, authenticated connections require STARTTLS. */
  secure?: boolean;
  auth?: { user: string; pass: string };
  from: string;
}

export function createSmtpMailer(config: SmtpMailerConfig): Mailer {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? false,
    // Credentials must never go over plaintext; unauthenticated dev SMTP (Mailpit) may.
    requireTLS: config.secure === true ? false : Boolean(config.auth),
    ...(config.auth ? { auth: config.auth } : {}),
  });
  return async (msg: MailMessage): Promise<void> => {
    await transport.sendMail({
      from: config.from,
      to: msg.to,
      ...(msg.bcc ? { bcc: msg.bcc } : {}),
      subject: msg.subject,
      text: msg.text,
      ...(msg.messageId ? { messageId: msg.messageId } : {}),
    });
  };
}

/** `local@domain` or `Display Name <local@domain>`. */
const MAIL_FROM_RE = /^(?:[^<>@]*<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

/** Fail at configuration time on a sender that is not an address (otherwise every send fails with 550). */
export function assertMailFrom(value: string, envName: string): void {
  if (!MAIL_FROM_RE.test(value.trim())) {
    throw new Error(`${envName} must be an address (\`bot@example.com\`) or \`Name <bot@example.com>\``);
  }
}

/** undefined without `SMTP_HOST`/`MAIL_FROM`: callers then skip email and keep in-app notifications. */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | undefined {
  if (!env.SMTP_HOST || !env.MAIL_FROM) return undefined;
  const port = Number(env.SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535');
  }
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) {
    throw new Error('SMTP_USER and SMTP_PASS must be configured together');
  }
  assertMailFrom(env.MAIL_FROM, 'MAIL_FROM');
  return createSmtpMailer({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE === 'true',
    ...(env.SMTP_USER && env.SMTP_PASS
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
      : {}),
    from: env.MAIL_FROM,
  });
}

export function renderNotificationEmail(
  n: { kind: string; title: string; body: string; link?: string },
  consoleBaseUrl?: string,
): { subject: string; text: string } {
  const url = n.link
    ? consoleBaseUrl
      ? `${consoleBaseUrl.replace(/\/+$/, '')}${n.link}`
      : n.link
    : undefined;
  return {
    subject: `[winnowl] ${n.title}`,
    text: [
      n.body || n.title,
      ...(url ? ['', `详情:${url}`] : []),
      '',
      '—— 本邮件由 winnowl 站内通知自动发出。',
    ].join('\n'),
  };
}
