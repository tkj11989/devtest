# Sports Space — Sports Venue Booking App

A mobile app for booking sports spaces (cricket turfs/nets, football, badminton, tennis, basketball…) by the hour.

| Step | Screen | What happens |
|---|---|---|
| 1 | **Login** | Enter a 10-digit mobile number → 6-digit **OTP by SMS** → verified, session stored securely on device |
| 2 | **Sport selection** | Grid of sports with venue counts |
| 3 | **Space selection** | Venues for that sport with location, hours and hourly price |
| 4 | **Date selection** | Next 14 days in a horizontal date strip |
| 5 | **Slot booking** | Hourly slots: available / booked / past; live re-check on focus |
| 6 | **Payment method** | **Pay Online** (UPI / Card / Net Banking, slot held for 10 min) or **Pay at Venue** (offline, confirmed instantly) |
| 7 | **Intimation** | Booking-confirmation **SMS** to the user + in-app confirmation screen with Booking ID |
| — | **My Bookings** | History with status, payment status and cancellation (cancellation SMS too) |

```
backend/   Node.js + Express REST API (OTP, catalog, slots, bookings, payments, SMS)
mobile/    React Native app (Expo SDK 58, Expo Router, TypeScript) — Android, iOS & web
```

## Quick start

```bash
# 1. API
cd backend
npm install
npm start            # http://localhost:4000 — SMS are printed to this console

# 2. App (in another terminal)
cd mobile
npm install
npx expo start       # scan the QR code with Expo Go, or press a / i / w
```

The app finds the API on the Expo dev server's host at port 4000. To use another
URL, set `EXPO_PUBLIC_API_URL=http://<your-ip>:4000` before `npx expo start`.

In dev mode (`SMS_PROVIDER=console`) the OTP is also shown on the OTP screen, so
you can log in without a real SMS gateway. Online payments use a **test-mode
checkout** (`PAYMENT_PROVIDER=mock`) with "Pay" and "Simulate payment failure" buttons.

## Going live

Copy `backend/.env.example` to set these as environment variables.

- **SMS (OTP + booking intimation):** `SMS_PROVIDER=twilio` or `SMS_PROVIDER=msg91`
  with its credentials. In India, MSG91 needs DLT-registered templates — one for
  the OTP and one for booking messages, each with a `message` variable.
- **Payments:** `PAYMENT_PROVIDER=razorpay` plus `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`.
  The API already creates Razorpay orders and verifies the `orderId|paymentId`
  HMAC signature. On the app side, swap the mock gateway in
  `mobile/src/app/checkout.tsx` for Razorpay Checkout (`react-native-razorpay`,
  which needs a development build rather than Expo Go) and post the returned
  `paymentId`/`signature` to `/bookings/:id/pay`.
- **Security:** set a strong `JWT_SECRET`. The server refuses to start without one when `NODE_ENV=production`.
- **Data:** the API uses an in-memory store, optionally mirrored to a JSON file (`DB_FILE`).
  Replace `backend/src/store.js` with a real database (PostgreSQL, MongoDB…) for production,
  and enforce one active booking per space/date/hour with a unique constraint.
- Venues and sports are seeded in `backend/src/seed.js`.

## API

All `/bookings` and `/payments` routes need `Authorization: Bearer <token>`.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/auth/send-otp` | `{ phone }` | 30 s resend cooldown, OTP valid for 5 min |
| POST | `/auth/verify-otp` | `{ phone, otp }` | Returns `{ token, user }`; max 5 attempts |
| GET | `/sports` | | |
| GET | `/sports/:sportId/spaces` | | |
| GET | `/spaces/:spaceId/slots` | `?date=YYYY-MM-DD` | Today up to 30 days ahead |
| POST | `/bookings` | `{ spaceId, date, startHour, paymentMethod: "OFFLINE" \| "ONLINE" }` | Offline → confirmed + SMS. Online → slot held, returns `order` |
| POST | `/bookings/:id/pay` | `{ paymentId, signature }` | Verifies the signature, confirms the booking, sends SMS |
| POST | `/bookings/:id/cancel` | | Frees the slot and sends an SMS |
| GET | `/bookings`, `/bookings/:id` | | The user's own bookings |
| POST | `/payments/mock-checkout` | `{ orderId, outcome? }` | Test gateway (mock provider only) |

## Tests

```bash
cd backend && npm test        # API tests: OTP, slots, offline/online booking, holds, cancel, auth
cd mobile && npm run typecheck
```
