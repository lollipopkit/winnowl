import { createTransport } from 'nodemailer';
import { renderForChannel } from './disclosure.js';
import type { SecurityFinding } from './types.js';

export interface EmailNotifierConfig {
  host: string;
  port: number;
  /** false for Mailpit/dev. */
  secure?: boolean;
  auth?: { user: string; pass: string };
  from: string;
  to: string | string[];
}

export interface SecurityNotifier {
  notify(finding: SecurityFinding): Promise<void>;
}

/** Private channel: full disclosure including exploit details, sent only to the security team. */
export function createEmailSecurityNotifier(config: EmailNotifierConfig): SecurityNotifier {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? false,
    ...(config.auth ? { auth: config.auth } : {}),
  });
  return {
    async notify(finding: SecurityFinding): Promise<void> {
      const disclosure = renderForChannel(finding, 'private');
      await transport.sendMail({
        from: config.from,
        to: config.to,
        subject: `[reviewbot security] ${finding.severity.toUpperCase()}: ${finding.title}`,
        text: disclosure.body,
      });
    },
  };
}
