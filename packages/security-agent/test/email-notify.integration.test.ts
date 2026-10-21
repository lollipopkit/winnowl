import { startMailpit, type StartedMailpit } from '@reviewbot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmailSecurityNotifier } from '../src/index.js';
import type { SecurityFinding } from '../src/index.js';

const finding: SecurityFinding = {
  id: 'f1',
  title: 'SQL injection in query builder',
  severity: 'high',
  category: 'sast',
  publicSummary: 'user input concatenated into SQL',
  exploitDetails: "'; DROP TABLE users; --",
  locationPermalink: 'src/db.ts#L10',
};

describe('Email 私密渠道投递', () => {
  let mail: StartedMailpit;

  beforeAll(async () => {
    mail = await startMailpit();
  }, 120_000);

  afterAll(async () => {
    await mail?.stop();
  });

  it('发送私密报告(含 exploit 细节)到 security 邮箱', async () => {
    const notifier = createEmailSecurityNotifier({
      host: mail.smtpHost,
      port: mail.smtpPort,
      from: 'winnowl@example.com',
      to: 'security@example.com',
    });
    await notifier.notify(finding);

    const msgs = await mail.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.subject).toContain('HIGH: SQL injection');
    expect(msgs[0]!.to).toContain('security@example.com');
    // Private channel: full disclosure.
    expect(msgs[0]!.body).toContain('DROP TABLE');
  });
});
