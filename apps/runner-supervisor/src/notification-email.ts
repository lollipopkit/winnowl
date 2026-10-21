import {
  claimPendingEmailNotifications,
  markNotificationEmailed,
  notificationRecipients,
  releaseNotificationEmailClaim,
  renewNotificationEmailClaim,
  renderNotificationEmail,
  type Mailer,
} from '@reviewbot/notifications';
import { uuidv7 } from '@reviewbot/ids';
import { JobExecutionError, JobInterruptedError, type JobHandler } from './supervisor.js';

/**
 * `notification_email`: email delivery of in-app notifications, best effort on top of the stored
 * notification. Failed sends leave emailed_at unset so the next round retries; without SMTP it is a no-op.
 */
export interface NotificationEmailPayload {
  tenantId: string;
}

export interface NotificationEmailDeps {
  /** Unset (no SMTP) → no email, notifications stay in-app. */
  mailer?: Mailer;
  /** Console base URL for turning relative notification links into absolute ones. */
  consoleBaseUrl?: string;
  /** Recipient roles (default owner/admin: notifications are mostly governance). */
  roles?: string[];
  /** Claim lease (shortened in tests; one hour in production). */
  claimLeaseSeconds?: number;
}

export function createNotificationEmailHandler(deps: NotificationEmailDeps): JobHandler {
  return async ({ job, db, log, signal }) => {
    const payload = job.payload as unknown as NotificationEmailPayload;
    if (payload.tenantId !== job.tenantId) {
      throw new JobExecutionError(
        'notification_email tenantId does not match the claimed job tenant',
        'configuration_invalid',
        false,
      );
    }
    if (!deps.mailer) return; // no SMTP: no-op

    const to = await notificationRecipients(db, payload.tenantId, deps.roles ?? ['owner', 'admin']);
    if (to.length === 0) {
      // No deliverable email (e.g. JIT placeholder accounts). Not marked sent, so it arrives once an email exists.
      log('通知邮件跳过:该租户无可投递收件人', { tenantId: payload.tenantId });
      return;
    }

    const claimToken = uuidv7();
    const claimLeaseSeconds = deps.claimLeaseSeconds ?? 3600;
    const pending = await claimPendingEmailNotifications(
      db,
      payload.tenantId,
      claimToken,
      50,
      claimLeaseSeconds,
    );
    if (pending.length === 0) return;

    let sent = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const n = pending[index]!;
      if (signal.aborted) {
        // Release unsent claims one by one, then throw: returning normally would mark the job completed
        // (see JobInterruptedError).
        await Promise.allSettled(
          pending
            .slice(index)
            .map((remaining) =>
              releaseNotificationEmailClaim(db, payload.tenantId, remaining.id, claimToken),
            ),
        );
        throw new JobInterruptedError(
          `notification email delivery interrupted: ${index} of ${pending.length} sent`,
        );
      }
      const owned = await renewNotificationEmailClaim(
        db,
        payload.tenantId,
        n.id,
        claimToken,
        claimLeaseSeconds,
      );
      if (!owned) {
        log('通知邮件 claim 已丢失,跳过发送', { notificationId: n.id });
        continue;
      }
      const { subject, text } = renderNotificationEmail(n, deps.consoleBaseUrl);
      let claimLost = false;
      let renewalPending = false;
      const renewal = setInterval(
        () => {
          if (renewalPending || claimLost) return;
          renewalPending = true;
          void renewNotificationEmailClaim(
            db,
            payload.tenantId,
            n.id,
            claimToken,
            claimLeaseSeconds,
          )
            .then((renewed) => {
              if (!renewed) claimLost = true;
            })
            .catch(() => {
              /*
               * A transient error is not a lost claim; only a renewal returning false is. Treating it as lost would
               * skip markNotificationEmailed after a successful send and resend the same email.
               */
            })
            .finally(() => {
              renewalPending = false;
            });
        },
        Math.max(1_000, Math.floor((claimLeaseSeconds * 1000) / 3)),
      );
      renewal.unref();
      try {
        await deps.mailer({
          to: 'undisclosed-recipients:;',
          bcc: to,
          subject,
          text,
          messageId: `<notification-${n.id}@winnowl.local>`,
        });
        /*
         * Sent means it must be marked. `markNotificationEmailed` is token-fenced (returns false without side
         * effects if the claim is not ours), so calling it unconditionally is safe; not calling it resends the
         * email after the claim expires. Retry a few times on DB errors before giving up.
         */
        let marked = false;
        for (let attempt = 0; attempt < 3 && !marked; attempt += 1) {
          marked = await markNotificationEmailed(db, payload.tenantId, n.id, claimToken).catch(
            () => false,
          );
          if (!marked && attempt < 2)
            await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        }
        if (marked) sent += 1;
        else
          log('通知邮件已发出但未标记(claim 到期后可能重复投递)', {
            notificationId: n.id,
            claimLost: claimLost || undefined,
          });
      } catch (error) {
        // Not marked → retried next round; one failure does not affect the rest.
        await releaseNotificationEmailClaim(db, payload.tenantId, n.id, claimToken).catch(
          () => false,
        );
        log('通知邮件投递失败(保留待重试)', {
          notificationId: n.id,
          error: (error as Error).message,
        });
      } finally {
        clearInterval(renewal);
      }
    }
    if (sent > 0)
      log('通知邮件已投递', { tenantId: payload.tenantId, sent, recipients: to.length });
  };
}
