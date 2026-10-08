# RT Harvester Proxy

Sits between your app and Auth0. Forwards all token requests unchanged, and silently imports refresh tokens into FusionAuth in the background. When you're ready to cut over, flip one env var. Existing sessions keep working, no re-login required.

```text
App → Proxy → Auth0   (harvest mode: RT imported into FA on every login)
App → Proxy → FA      (after cutover: AUTH_PROVIDER=fusionauth)
```

---

## Before You Start

You'll need:

- An Auth0 tenant with your users
- A FusionAuth instance (cloud or self-hosted)
- Node.js 18+

---

## Step 1: Migrate your users to FusionAuth

The proxy matches users by email. Every user must exist in FusionAuth **before** the harvest window opens, with the same email address they use in Auth0.

Import users via the FusionAuth admin UI or bulk import API before proceeding.

Each user must also be **registered to the FA application** (not just exist in FA). Being in FA isn't enough - FusionAuth requires application registration before it will accept an RT import for that user.

In FA admin: **Users → [user] → Registrations tab → Add registration → select your application**

---

## Step 2 - Add the Auth0 post-login Action

The proxy reads the user's email from the access token to look them up in FusionAuth. Auth0 doesn't include email in the AT by default - add this Action to put it there.

1. In Auth0, go to **Actions → Library → Create Action**
2. Choose trigger: **Login / Post Login**
3. Paste this code:

```javascript
exports.onExecutePostLogin = async (event, api) => {
  api.accessToken.setCustomClaim('email', event.user.email);
};
```

4. Click **Deploy**
5. Go to **Actions → Triggers → post-login** and drag your new action into the flow
6. Click **Apply**

---

## Step 3 - Configure FusionAuth

### Create or confirm your application
In FA admin: **Applications → your app → OAuth tab**

Make note of:
- **Client ID** - this is your `FA_APPLICATION_ID`
- **Client secret** - this is your `FA_CLIENT_SECRET`

### Set a generous refresh token lifetime
The proxy imports RTs with `startInstant` set to the time of import (not the original Auth0 issue time). FA uses `startInstant` to calculate expiration based on your configured lifetime. Set the lifetime long enough that users who log in at the start of your harvest window still have a valid RT when you cut over.

In FA admin: **Applications → your app → OAuth tab → Refresh token time-to-live**

Recommended: 30 days minimum, or longer than your planned harvest window.

### Get your API key
The proxy needs an API key with permission to read users and import refresh tokens.

In FA admin: **Settings → API Keys → Add API key**

Required permissions:
- `GET /api/user` - user lookup
- `POST /api/user/refresh-token/import` - RT import

Note the key value - this is your `FA_API_KEY`.

### Get your Tenant ID
In FA admin: **Tenants → your tenant** - the ID is shown at the top.

---

## Step 4 - Install and configure the proxy

```bash
git clone <repo>
cd rt-harvester-proxy
npm install
cp .env.example .env
```

Edit `.env`:

```dotenv
# Auth0
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=your-auth0-client-id
AUTH0_CLIENT_SECRET=your-auth0-client-secret

# FusionAuth
FA_URL=https://your-instance.fusionauth.io
FA_API_KEY=your-fa-api-key
FA_APPLICATION_ID=your-fa-application-id
FA_CLIENT_SECRET=your-fa-client-secret
FA_TENANT_ID=your-fa-tenant-id

# Start in harvest mode
AUTH_PROVIDER=auth0

# Set true in test/UAT environments only
IS_TEST_ENV=false

PORT=3001
```

**Where to find each value:**

| Variable | Where to find it |
|---|---|
| `AUTH0_DOMAIN` | Auth0 → Settings → General → Domain |
| `AUTH0_CLIENT_ID` | Auth0 → Applications → your app → Settings |
| `AUTH0_CLIENT_SECRET` | Auth0 → Applications → your app → Settings |
| `FA_URL` | Your FusionAuth base URL |
| `FA_API_KEY` | FA admin → Settings → API Keys (Step 3) |
| `FA_APPLICATION_ID` | FA admin → Applications → your app → OAuth tab |
| `FA_CLIENT_SECRET` | FA admin → Applications → your app → OAuth tab |
| `FA_TENANT_ID` | FA admin → Tenants → your tenant |

---

## Step 5 - Point your app at the proxy

Change your app's Auth0 base URL to point at the proxy instead.

Before:
```
https://your-tenant.us.auth0.com
```

After:
```
http://localhost:3001   (or wherever the proxy is hosted)
```

Your app's client ID, client secret, and redirect URIs stay the same - the proxy handles the credential swap to FA automatically on both the `/authorize` redirect and the `/oauth/token` exchange.

---

## Step 6 - Start harvesting

```bash
npm start
```

Have users log in normally. For each login, you should see:

```
[import] RT imported for user@example.com (userId: ...)
```

To verify in FA admin: **Users → [user] → Sessions tab** - the imported RT will appear there.

---

## Step 7 - Cut over to FusionAuth

Once you're confident RTs are importing (or after your harvest window closes):

1. Set `AUTH_PROVIDER=fusionauth` in `.env`
2. Restart the proxy
3. Done - new logins and token refreshes now go to FusionAuth

Existing sessions will silently exchange their harvested RT for a FA-issued access token on the next refresh. Users never see a login prompt.

---

## Verifying the cutover worked

After flipping to FusionAuth, trigger a token refresh in your app (any action that causes the app to call the token endpoint with a refresh token). In FA admin, check **Users → [user] → Sessions tab** - the "Last accessed" timestamp should update, confirming FA handled the exchange.

---

## Rollback

Set `AUTH_PROVIDER=auth0` and restart. Sessions will resume against Auth0. No data is lost.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[import] no email claim in access token` | Auth0 Action not deployed or not in flow | Re-check Step 2 |
| `[import] no FA user found for email` | User not migrated to FA | Import the user first |
| `invalid_client` error after cutover | Wrong or missing `FA_CLIENT_SECRET` | Check `.env` and restart |
| `missing_grant_type` error | Content-type mismatch | Ensure proxy version is current |
| Sessions tab empty after login | User not registered to the FA application | Register user to the application in FA admin |
| RT not refreshing after cutover | AT not yet expired / app not triggering refresh | Force a token refresh or wait for AT expiry |