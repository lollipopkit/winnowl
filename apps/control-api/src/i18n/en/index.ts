import type { BaseTranslation } from '../i18n-types.js';

/**
 * Outgoing email copy; base locale. The invitee's language is unknown, so the inviter's UI locale is used.
 * To add a language, create `src/i18n/<locale>/index.ts` and run `pnpm --filter @reviewbot/control-api i18n`.
 */
const en = {
  inviteEmail: {
    subject: "[winnowl] You're invited to join {tenant:string}",
    intro: 'You have been invited to join "{tenant:string}" on winnowl as {role:string}.',
    acceptWithLink: 'Accept the invite here (sign in with this email address first):',
    acceptWithToken: 'Sign in to the winnowl console with this email address and accept with this token:',
    expires: 'The invite expires at {expiresAt:string}.',
    ignore: 'If you were not expecting this invitation, you can ignore this email.',
  },
} satisfies BaseTranslation;

export default en;
