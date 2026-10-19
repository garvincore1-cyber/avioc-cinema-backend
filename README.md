# Avioc Cinema API (Render)

This service provides verified email accounts, password recovery, UGX subscription checkout, and LivePay webhook activation. Subscription access begins only after a valid signed LivePay success webhook matches the stored payment amount, currency, and reference.

## Included plans

| Pass | UGX |
|---|---:|
| 1 day | 1,000 |
| 3 days | 2,000 |
| 7 days | 5,000 |
| 14 days | 10,000 |
| 30 days | 20,000 |
| 60 days | 38,000 |
| 90 days | 55,000 |

Card checkout uses fixed USD prices and shows only these durations:

| Pass | USD |
|---|---:|
| 14 days | 3.80 |
| 30 days | 6.00 |
| 60 days | 9.00 |
| 90 days | 11.50 |

## Render deployment

Create a MongoDB Atlas cluster, database user, and network access rule, then create a Render Node web service with this directory as its root. Use `npm install` as the build command and `npm start` as the start command. Set `MONGODB_URI` to the Atlas driver connection string and `MONGODB_DB=avioc_cinema`. The service creates the required indexes at startup. MongoDB transactions are used to atomically process payment webhooks and subscription activation, so use an Atlas replica set deployment (Atlas clusters provide this).

Add the variables listed in `.env.example` in the Render dashboard. Generate `TOKEN_SECRET` as a long random value. Set `API_BASE_URL` to the public Render service URL. Configure the exact `LIVEPAY_WEBHOOK_URL` in both Render and the LivePay dashboard. Set `EMAIL_FROM` to a sender domain verified by Resend.

No API credentials belong in frontend code, Git, or this file. Use Render's environment variable settings for secrets. URL-encode any special characters in the database user's password before placing it in `MONGODB_URI`.

## LivePay methods and limits

- MTN and Airtel are initiated through LivePay's UGX `collect-money` endpoint. The API documentation does not define a network selector for UGX collection; the customer enters the mobile-money number and LivePay routes the request. The requested network is recorded for support, but the phone number is what determines routing. Confirm with LivePay if they support enforcing the selected network.
- Card payments use LivePay's USD-only `card-collection` endpoint. Card passes are 14 days for USD 3.80, 30 days for USD 6.00, 60 days for USD 9.00, and 90 days for USD 11.50. LivePay documents a USD 1.00 minimum.
- LivePay's interactive API playground uses real endpoints. Do not test it with real customer payment details or funds unless you intend to make a real charge.

## API outline

- `GET /healthz`
- `GET /api/plans`
- `GET /api/prices/card`
- `POST /api/auth/register` — `{ email, displayName, password }`
- `GET /api/auth/verify-email?token=...` — email confirmation link
- `POST /api/auth/login` — `{ email, password }`
- `POST /api/auth/request-password-reset` — `{ email }`
- `POST /api/auth/reset-password` — `{ token, password }`
- `GET /api/me` — verified-account profile and current pass expiry
- `POST /api/payments` — bearer token, `{ planId, method, phoneNumber, network, name }`
- `GET /api/payments/:reference` — bearer token, current payment status
- `POST /api/payments/livepay-webhook` — signed LivePay webhook

Authenticated routes use `Authorization: Bearer <token>`. The email verification route is public because the customer opens the link from their inbox.

## Frontend and Bunny follow-up

The cinema page now has Account, create-account, sign-in, password-reset, pass selection, and LivePay checkout flows connected to these endpoints. After deployment, set the public Render API URL in the root `api-config.js`; this URL is not a secret. The existing build step copies this configuration into Firebase Hosting.

The catalog still embeds direct Bunny CDN video URLs. The account UI checks subscription status before starting playback, but this client-side gate does not protect a public video URL opened directly. Before charging customers for access, Bunny token authentication must be enabled for the media CDN and the player must request short-lived signed media URLs from the backend. That requires the Bunny token-auth key as a Render secret and a media path mapping. Bunny token authentication may also affect poster images because artwork and videos currently share a CDN hostname; preserve poster access or separate public artwork from protected media when configuring the zone.

Email verification uses Resend. Registration remains unavailable until the sender domain and Resend key are configured. Do not put LivePay, Resend, database, JWT, or Bunny secrets in the app's HTML.
