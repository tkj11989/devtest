import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Point the app at the backend with EXPO_PUBLIC_API_URL. When unset, fall back
// to the dev server's host so a physical device on the same Wi-Fi works.
function defaultBaseUrl() {
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host) return `http://${host}:4000`;
  return Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';
}

export const API_URL = process.env.EXPO_PUBLIC_API_URL || defaultBaseUrl();

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(authToken && { Authorization: `Bearer ${authToken}` }),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your internet connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && authToken) onUnauthorized?.();
    throw new ApiError(res.status, data.error || 'UNKNOWN', data.message || 'Something went wrong', data);
  }
  return data as T;
}

export type Sport = { id: string; name: string; icon: string; spaceCount: number };
export type Space = {
  id: string;
  sportId: string;
  name: string;
  location: string;
  pricePerSlot: number;
  openHour: number;
  closeHour: number;
};
export type Slot = { startHour: number; label: string; price: number; status: 'AVAILABLE' | 'BOOKED' | 'PAST' };
export type PaymentMethod = 'OFFLINE' | 'ONLINE';
export type Booking = {
  id: string;
  code: string;
  phone: string;
  sportName: string;
  spaceName: string;
  location: string;
  date: string;
  startHour: number;
  slotLabel: string;
  amount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: 'PENDING' | 'PAID' | 'PAY_AT_VENUE';
  status: 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'FAILED';
  smsStatus: 'PENDING' | 'SENT' | 'FAILED';
  orderId?: string;
  holdExpiresAt?: string;
};
export type Order = { provider: 'mock' | 'razorpay'; orderId: string; amount: number; currency: string; keyId?: string };
