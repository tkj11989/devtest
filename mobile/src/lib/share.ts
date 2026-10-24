import { Share } from 'react-native';
import type { Booking } from './api';
import { prettyDate, rupees, slotRange } from './format';

export function shareBooking(b: Booking) {
  return Share.share({
    message:
      `🏟️ ${b.groundName}, ${b.area}, ${b.cityName}\n` +
      `📅 ${prettyDate(b.date)} · ${slotRange(b.startHour)}\n` +
      `🎟️ Booking ID: ${b.code} · ${rupees(b.total)}\n` +
      `Booked on Sports Space`,
  });
}
