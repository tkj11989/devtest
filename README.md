# Sports Space — Sports Venue Booking App

A mobile app for booking sports spaces (cricket turfs/nets, football, badminton, tennis, basketball…) by the hour.

**Players**

| # | Screen | What it does |
|---|---|---|
| — | **Login** | 10-digit mobile number → 6-digit **OTP by SMS** → name (first login only). Session stored securely on device |
| 1 | **Home** | City picker, notifications, search, promo banners, **sport selection**, Near Me / Turf / Stadium / Indoor shortcuts, Popular Grounds |
| 2 | **Ground Listing** | Search by name or area, filter chips (Near Me, Turf, Stadium, Indoor, Floodlight), rating, price per hour, favourites |
| 3 | **Ground Details** | Photo carousel, rating & reviews, distance, amenities, Overview / Photos / Reviews tabs, Book Now |
| 4 | **Select Date & Slot** | Month calendar (today + 30 days) and a grid of hourly slots; booked slots greyed out |
| 5 | **Booking Summary** | Date, time, price, **Apply Coupon** (`FIRST100`, `PLAY10`), booking amount + ₹50 platform fee = total |
| 6 | **Payment** | **Online**: UPI, Credit/Debit Card, Net Banking, Wallet (slot held 10 min). **Offline**: Pay at Venue (confirmed instantly) |
| 7 | **Booking Confirmation** | Booking ID, date, time, amount, Paid / Pay at Venue badge, **SMS intimation** notice, View Booking, Share |
| 8 | **My Bookings** | Upcoming / Past / Cancelled tabs |
| 9 | **Ticket** | Booking details with a **QR code** to show at the venue; share; cancel (refund for online payments) |
| 10 | **Profile** | Name & phone, My Bookings, My Payments, My Favorites, Notifications, Help & Support, Logout |

**Stadium owners** (any number set as a ground's owner; the demo data uses `9000000001`, or set `OWNER_PHONE`)

| # | Screen | What it does |
|---|---|---|
| 11 | **Stadium Dashboard** | Total bookings, revenue, upcoming, completed; today's bookings; tap a Pending (pay-at-venue) booking to mark cash collected |
| 12 | **Manage Slots** | Pick a ground and date; switch slots on/off for that date; add slots, edit prices, delete slots |

**Payments & payouts**

- **Owner payout account:** owners add a **UPI ID** or **bank account (number + IFSC)**, the account holder name and a **payment contact number** (Dashboard → Earnings & Payouts → Payout account). Until they do, their grounds take pay-at-venue bookings only.
- **Online payments are split at source:** the slot price is credited **directly to the owner's account**; the **platform fee** stays in the platform's own payment-gateway account. If a coupon is bigger than the platform fee, the platform tops up the owner, so owners always receive the full slot price.
- **Pay at venue:** the owner collects the full amount and marks it paid on the dashboard; the platform fee is then recorded as **due from the owner**.
- **Cancellations** of paid online bookings reverse both shares in the ledger.
- **Owner – Earnings & Payouts:** credited to account, collected at venue, platform fees due, and every transaction.
- **Platform Admin** (sign in with `ADMIN_PHONE`, default `9000000000`, then Profile → Platform Admin): net platform earnings, fees collected online, fees due from and received from venues, coupon top-ups, owner payout accounts; link an owner's Razorpay account and record fees an owner has paid.

Every booking confirmation or cancellation is sent by **SMS** and saved as an in-app **notification**.

Venue photos are drawn as floodlit-ground illustrations for each sport (`mobile/src/components/GroundArt.tsx`) until venues upload real photos.

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
- **Payment split (Razorpay Route):** enable **Route** on the platform's Razorpay account, which is where platform fees land and settle to the platform's bank. For each owner, create a **Linked Account** in the Razorpay dashboard (Route → Linked Accounts) using the bank details they entered, then paste its `acc_…` ID in the app (Platform Admin → Link Razorpay account). Orders are then created with a Route `transfers` entry, so the owner's share moves to their linked account when the payment is captured. Coupon top-ups use a direct transfer from the platform balance. Online payments for an owner's grounds stay off until the account is linked. Razorpay Route settles linked accounts to **bank accounts**; owners who give only a UPI ID need a bank account added for Razorpay, or a RazorpayX Payouts integration (not included). Refund reversals for cancellations are recorded in the ledger, but the Razorpay refund and transfer-reversal API calls still need to be added.
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
- Cities, sports, grounds, reviews and coupons are seeded in `backend/src/seed.js`. The platform fee is `PLATFORM_FEE` (default ₹50).

## API

All `/me`, `/notifications`, `/bookings`, `/payments`, `/owner` and `/admin` routes need `Authorization: Bearer <token>`.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/auth/send-otp` | `{ phone }` | 30 s resend cooldown, OTP valid for 5 min |
| POST | `/auth/verify-otp` | `{ phone, otp }` | Returns `{ token, user }`; max 5 attempts |
| GET/PATCH | `/me` | `{ name }` | Profile; `isOwner` flag |
| PUT | `/me/favorites/:groundId` | `{ favorite }` | |
| GET | `/notifications`, POST `/notifications/read` | | In-app copies of booking SMS |
| GET | `/cities`, `/sports?city=`, `/coupons` | | |
| GET | `/grounds` | `?city&sport&type&floodlights=1&favorites=1&q&lat&lng&sort=distance\|price` | Sorted by rating by default |
| GET | `/grounds/:id` | `?lat&lng` | Details + reviews |
| GET | `/grounds/:id/slots` | `?date=YYYY-MM-DD` | Today up to 30 days ahead |
| POST | `/bookings/quote` | `{ groundId, date, startHour, couponCode? }` | Amount, platform fee, discount, total |
| POST | `/bookings` | `{ groundId, date, startHour, couponCode?, paymentMethod: "OFFLINE" \| "ONLINE", paymentChannel?: "UPI" \| "CARD" \| "NETBANKING" \| "WALLET" }` | Offline → confirmed + SMS. Online → slot held, returns `order` |
| POST | `/bookings/:id/pay` | `{ paymentId, signature }` | Verifies the signature, confirms the booking, sends SMS |
| POST | `/bookings/:id/cancel` | | Frees the slot and sends an SMS |
| GET | `/bookings`, `/bookings/:id` | | The user's own bookings |
| POST | `/payments/mock-checkout` | `{ orderId, outcome? }` | Test gateway (mock provider only) |
| GET | `/owner/grounds`, `/owner/dashboard?groundId=` | | Owner only |
| POST | `/owner/bookings/:id/collect` | | Mark a pay-at-venue booking paid |
| GET/POST | `/owner/grounds/:id/slots` | `?date=` / `{ startHour, price }` | List with on/off state / add slot |
| PATCH/DELETE | `/owner/grounds/:id/slots/:hour` | `{ price }` | Edit price / delete slot |
| PUT | `/owner/grounds/:id/slots/:hour/availability` | `{ date, enabled }` | Switch a slot off/on for one date |
| GET/PUT | `/owner/payout` | `{ method: "UPI" \| "BANK", accountHolder, contactPhone, upiId? , accountNumber?, ifsc? }` | Owner's payout account (account number returned masked) |
| GET | `/owner/earnings` | | Credited, collected at venue, fees due, ledger |
| GET | `/admin/summary` | | Admin only: platform earnings and owners |
| PUT | `/admin/owners/:phone/linked-account` | `{ linkedAccountId }` | Razorpay Route `acc_…` ID |
| POST | `/admin/owners/:phone/dues-received` | `{ amount }` | Platform fees paid by an owner |

## Tests

```bash
cd backend && npm test        # API tests: OTP, catalog, favorites, coupons, booking, holds, cancel, owner tools, payouts & split
cd mobile && npm run typecheck
```
