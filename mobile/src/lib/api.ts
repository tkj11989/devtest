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

export function qs(params: Record<string, string | number | undefined | null | false>) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export type User = { phone: string; name: string; favorites: string[]; isOwner: boolean; isAdmin: boolean };
export type City = { id: string; name: string; state: string; lat: number; lng: number };
export type Sport = { id: string; name: string; icon: string; groundCount: number };
export type GroundType = 'Turf' | 'Stadium' | 'Indoor';
export type Ground = {
  id: string;
  sportId: string;
  type: GroundType;
  name: string;
  city: string;
  cityName: string;
  state: string;
  area: string;
  lat: number;
  lng: number;
  rating: number;
  reviewCount: number;
  floodlights: boolean;
  amenities: string[];
  about: string;
  pricePerHour: number;
  distanceKm: number | null;
  isFavorite: boolean;
  onlinePayments: boolean; // false until the owner has a payout account set up
};
export type Review = { id: string; name: string; rating: number; comment: string; date: string };
export type GroundDetails = Ground & { sport: Sport; reviews: Review[] };
export type SlotStatus = 'AVAILABLE' | 'BOOKED' | 'PAST' | 'BLOCKED';
export type Slot = { startHour: number; label: string; price: number; status: SlotStatus };
export type Quote = { amount: number; platformFee: number; discount: number; couponCode: string | null; total: number };
export type Coupon = { code: string; description: string };
export type PaymentMethod = 'OFFLINE' | 'ONLINE';
export type PaymentChannel = 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET' | 'VENUE';
export type Booking = Quote & {
  id: string;
  code: string;
  phone: string;
  customerName: string;
  sportId: string;
  sportName: string;
  groundId: string;
  groundName: string;
  groundType: GroundType;
  area: string;
  cityName: string;
  date: string;
  startHour: number;
  slotLabel: string;
  paymentMethod: PaymentMethod;
  paymentChannel: PaymentChannel;
  paymentStatus: 'PENDING' | 'PAID' | 'PAY_AT_VENUE' | 'REFUND_INITIATED';
  status: 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'FAILED';
  smsStatus: 'PENDING' | 'SENT' | 'FAILED';
  started?: boolean;
  orderId?: string;
  holdExpiresAt?: string;
  createdAt: string;
  paidAt?: string;
};
export type Order = { provider: 'mock' | 'razorpay'; orderId: string; amount: number; currency: string; keyId?: string };
export type AppNotification = { id: string; bookingId?: string; title: string; message: string; read: boolean; createdAt: string };

export type Payout = {
  method: 'UPI' | 'BANK';
  accountHolder: string;
  contactPhone: string;
  upiId?: string;
  ifsc?: string;
  accountNumberMasked: string | null;
  linkedAccountId?: string;
  destination: string;
  status: 'ACTIVE' | 'PENDING_LINK';
  updatedAt: string;
};
export type LedgerType = 'OWNER_PAYOUT' | 'PLATFORM_SUBSIDY' | 'PLATFORM_FEE' | 'VENUE_COLLECTION' | 'FEE_DUE' | 'DUES_SETTLED';
export type LedgerEntry = {
  id: string;
  bookingCode: string | null;
  groundName: string | null;
  type: LedgerType;
  amount: number;
  status: 'PROCESSED' | 'INITIATED' | 'FAILED';
  destination?: string;
  reversal?: boolean;
  createdAt: string;
};
export type Earnings = {
  paidToAccount: number;
  collectedAtVenue: number;
  platformFeesDue: number;
  entries: LedgerEntry[];
  payout: Payout | null;
};
export type AdminSummary = {
  feesCollectedOnline: number;
  subsidiesPaid: number;
  paidToOwners: number;
  feesDueFromVenues: number;
  duesReceived: number;
  paymentProvider: 'mock' | 'razorpay';
  bookings: number;
  grossBookingValue: number;
  owners: {
    phone: string;
    name: string;
    grounds: string[];
    payout: Payout | null;
    paidToAccount: number;
    collectedAtVenue: number;
    platformFeesDue: number;
  }[];
};
