import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(() => ({ sendMail: vi.fn(async () => undefined) })),
}));

vi.mock('nodemailer', () => ({ createTransport: mocks.createTransport }));

async function loadMailer() {
  vi.resetModules();
  return import('../src/mailer.js');
}

describe('SMTP transport security', () => {
  beforeEach(() => mocks.createTransport.mockClear());

  it('requires STARTTLS when credentials are used on a non-secure connection', async () => {
    const { createSmtpMailer } = await loadMailer();
    createSmtpMailer({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: 'secret' },
      from: 'bot@example.com',
    });
    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: true }),
    );
  });

  it('allows unauthenticated development SMTP without STARTTLS', async () => {
    const { createSmtpMailer } = await loadMailer();
    createSmtpMailer({ host: '127.0.0.1', port: 1025, secure: false, from: 'bot@example.com' });
    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: false }),
    );
  });

  it('rejects invalid SMTP ports at configuration time', async () => {
    const { mailerFromEnv } = await loadMailer();
    expect(() =>
      mailerFromEnv({
        SMTP_HOST: 'smtp.example.com',
        MAIL_FROM: 'bot@example.com',
        SMTP_PORT: 'NaN',
      }),
    ).toThrow('SMTP_PORT must be an integer between 1 and 65535');
  });

  it('requires SMTP credentials to be configured as a pair', async () => {
    const { mailerFromEnv } = await loadMailer();
    expect(() =>
      mailerFromEnv({
        SMTP_HOST: 'smtp.example.com',
        MAIL_FROM: 'bot@example.com',
        SMTP_USER: 'bot',
      }),
    ).toThrow('SMTP_USER and SMTP_PASS must be configured together');
  });

  it('rejects a MAIL_FROM that is not an address at configuration time', async () => {
    const { mailerFromEnv } = await loadMailer();
    for (const from of ['mail.example.com', 'bot@', 'Bot <mail.example.com>']) {
      expect(() => mailerFromEnv({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: from })).toThrow('MAIL_FROM must be');
    }
    for (const from of ['bot@mail.example.com', 'Winnowl <bot@mail.example.com>']) {
      expect(mailerFromEnv({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: from })).toBeDefined();
    }
  });
});
