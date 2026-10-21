/** Module state: login triggers are scattered, but there must be a single dialog instance (focus/Esc ownership). */
export const loginDialog = $state({ open: false });

export function openLogin(): void {
  loginDialog.open = true;
}
