export function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

export function message(error: unknown): string {
  const text = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (/invalid_invitation/.test(text)) return 'This invitation does not match this account, or the link has expired. Switch Google account or ask for a new link.';
  if (/stale_version/.test(text)) return 'Someone changed this already. Refresh to see the latest version before trying again.';
  if (/already_needed/.test(text)) return 'This item is already on the shopping list. Check the existing request.';
  if (/item_claimed/.test(text)) return 'Someone else is getting this item. Ask them to release it first.';
  if (/invalid_quantity/.test(text)) return 'Enter a quantity greater than zero and no more than the amount needed.';
  if (/purchase_linked/.test(text)) return 'Correct or void the linked expense before undoing this purchase.';
  if (/has_refunds/.test(text)) return 'Undo the recorded refunds before correcting or voiding this expense.';
  if (/invalid_refund/.test(text)) return 'The refund must be positive and no more than the amount still refundable.';
  if (/last_organiser/.test(text)) return 'Make another person an organiser before removing the last organiser.';
  if (/invalid_payment|invalid_action/.test(text)) return 'This action is no longer available. Refresh and check its current status.';
  if (/reason_required/.test(text)) return 'Add a short reason so everyone can understand the change.';
  if (/trip_member_must_belong/.test(text)) return 'This person needs to join your household before joining the trip.';
  if (/forbidden|permission denied/.test(text)) return 'You do not have access to this household or trip. Try refreshing your households.';
  if (/unauthenticated/.test(text) || ['28000', 'PGRST301', 'PGRST303'].includes(errorCode(error))) return 'Your session has ended. Sign in again to continue.';
  if (/invalid_split/.test(text)) return 'Choose who shares the expense and make sure their amounts add up to the total.';
  if (/invalid_payer/.test(text)) return 'The payer needs to be a current member. Refresh and choose them again.';
  if (/invalid_amount/.test(text)) return 'Enter an amount between $0.01 and $1,000,000.';
  if (/invalid_email/.test(text)) return 'Enter a valid Google email address.';
  if (/invalid_parent/.test(text)) return 'Choose a household for this trip.';
  if (/idempotency_conflict/.test(text)) return 'This save differs from the earlier request. Check your expense list before starting again.';
  if (/fetch|network|timeout|timed out|abort|load failed/i.test(text)) return 'We could not connect. Check your internet connection and try again.';
  // Our own validation errors are written for people; do not expose raw database errors.
  if (error instanceof Error && !errorCode(error)) return text || 'Something went wrong. Please try again.';
  return 'We could not complete that action. Please try again.';
}

export function authError(error: unknown): boolean {
  return ['28000', 'PGRST301', 'PGRST303'].includes(errorCode(error)) || /unauthenticated|jwt expired/i.test(String((error as {message?:string})?.message ?? ''));
}

export function accessError(error: unknown): boolean {
  return ['42501', '28000', 'PGRST301', 'PGRST303'].includes(errorCode(error)) ||
    /forbidden|unauthenticated/.test(String((error as {message?: string})?.message ?? ''));
}

export function definitelyRejected(error: unknown): boolean {
  return ['P0001', '23514', '23503', '23502', '42501', '28000', '22P02', '22007', '22008'].includes(errorCode(error));
}
