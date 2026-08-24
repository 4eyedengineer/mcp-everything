import { HttpErrorResponse } from '@angular/common/http';
import { parseHttpError } from './http-error.util';

/**
 * Turn a failed billing request into a user-facing message.
 *
 * The backend returns a 400 with "Stripe is not configured" when billing has
 * not been wired up yet (no `STRIPE_SECRET_KEY`). That is an operator state, not
 * a user error, so we surface an honest "not available yet" line instead of the
 * raw backend text. Everything else falls back to the shared error parser.
 */
export function billingErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.'
): string {
  const httpError = error as HttpErrorResponse;
  const detail = parseHttpError(httpError, fallback);

  if (httpError?.status === 400 && /stripe is not configured/i.test(detail)) {
    return "Billing isn't available yet. Please check back later.";
  }

  return detail;
}
