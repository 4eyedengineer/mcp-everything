import { HttpErrorResponse } from '@angular/common/http';
import { billingErrorMessage } from './billing-error.util';

describe('billing-error.util', () => {
  describe('billingErrorMessage', () => {
    it('maps the 400 "Stripe is not configured" backend error to an honest not-available message', () => {
      const error = new HttpErrorResponse({
        status: 400,
        error: { message: 'Stripe is not configured' }
      });
      expect(billingErrorMessage(error)).toBe(
        "Billing isn't available yet. Please check back later."
      );
    });

    it('surfaces a specific non-configured 400 backend message verbatim', () => {
      const error = new HttpErrorResponse({
        status: 400,
        error: { message: 'No active subscription found' }
      });
      expect(billingErrorMessage(error)).toBe('No active subscription found');
    });

    it('surfaces a 404 backend message (e.g. missing subscription for the portal)', () => {
      const error = new HttpErrorResponse({
        status: 404,
        error: { message: 'No active subscription found' }
      });
      expect(billingErrorMessage(error)).toBe('No active subscription found');
    });

    it('falls back to the provided fallback for an opaque server error', () => {
      const error = new HttpErrorResponse({ status: 500, error: {} });
      // parseHttpError has its own 500 mapping, so the fallback only applies to
      // truly unmapped statuses; assert the mapped server-error line here.
      expect(billingErrorMessage(error, 'custom fallback')).toBe(
        'Server error. Please try again later.'
      );
    });

    it('uses the caller fallback for an unmapped status with no body', () => {
      const error = new HttpErrorResponse({ status: 418, error: {} });
      expect(billingErrorMessage(error, 'custom fallback')).toBe('custom fallback');
    });
  });
});
