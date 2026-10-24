import type { Tone } from '../components/ui';
import type { Booking } from './api';

export function bookingBadge(b: Booking): { label: string; tone: Tone } {
  if (b.status === 'CANCELLED') return { label: b.paymentStatus === 'REFUND_INITIATED' ? 'Refund Initiated' : 'Cancelled', tone: 'red' };
  if (b.started) return { label: 'Completed', tone: 'grey' };
  if (b.paymentStatus === 'PAID') return { label: 'Paid', tone: 'green' };
  return { label: 'Pay at Venue', tone: 'amber' };
}
