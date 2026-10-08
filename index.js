require('dotenv').config();
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pull all config from environment variables.
// AUTH_PROVIDER controls which identity provider is active:
//   'auth0'      - harvest mode: requests go to Auth0, RTs are imported into FA in the background
//   'fusionauth' - cutover mode: requests go directly to FusionAuth
const {
  AUTH_PROVIDER = 'auth0',
  AUTH0_DOMAIN,
  AUTH0_CLIENT_ID,
  AUTH0_CLIENT_SECRET,
  FA_URL,
  FA_API_KEY,        // FA API key — needs GET /api/user and POST /api/user/refresh-token/import permissions
  FA_APPLICATION_ID, // FA application client ID (replaces AUTH0_CLIENT_ID when routing to FA)
  FA_TENANT_ID,
  FA_CLIENT_SECRET,  // FA application client secret (replaces AUTH0_CLIENT_SECRET when routing to FA)
  IS_TEST_ENV = 'false', // set 'true' in UAT/test to enable validateDbConstraints on RT import
  PORT = 3000,
} = process.env;

// ─── Token endpoint ───────────────────────────────────────────────────────────
// All token requests from your app come here (authorization_code, refresh_token, etc.).
//
// In harvest mode (AUTH_PROVIDER=auth0):
//   - Forwards the request to Auth0 unchanged
//   - Returns the Auth0 response to your app immediately
//   - Then asynchronously imports the refresh token into FusionAuth in the background
//
// In cutover mode (AUTH_PROVIDER=fusionauth):
//   - Swaps Auth0 credentials for FA credentials (your app doesn't need to change)
//   - Re-encodes the body as form-urlencoded (FA follows the OAuth spec; Auth0 accepts JSON)
//   - Forwards to FusionAuth and returns the response

app.post('/oauth/token', async (req, res) => {
  const upstream =
    AUTH_PROVIDER === 'fusionauth'
      ? `${FA_URL}/oauth2/token`
      : `https://${AUTH0_DOMAIN}/oauth/token`;

  const isFa = AUTH_PROVIDER === 'fusionauth';

  // When routing to FA, replace the Auth0 client credentials with FA's.
  // Your app always sends AUTH0_CLIENT_ID/SECRET — the proxy swaps them here
  // so your app code never needs to know about FA credentials.
  const bodyObj = isFa
    ? { ...req.body, client_id: FA_APPLICATION_ID, client_secret: FA_CLIENT_SECRET }
    : req.body;

  // FA requires application/x-www-form-urlencoded per the OAuth spec.
  // Auth0 accepts JSON, so we only re-encode when routing to FA.
  const payload = isFa ? new URLSearchParams(bodyObj).toString() : bodyObj;
  const contentType = isFa ? 'application/x-www-form-urlencoded' : 'application/json';

  let upstreamRes;
  try {
    upstreamRes = await axios.post(upstream, payload, {
      headers: { 'Content-Type': contentType },
      validateStatus: () => true, // handle all status codes ourselves, don't throw on 4xx/5xx
    });
  } catch (err) {
    console.error('[proxy] upstream error:', err.message);
    return res.status(502).json({ error: 'upstream_unavailable' });
  }

  console.log('[proxy] upstream status:', upstreamRes.status, 'has RT:', !!upstreamRes.data.refresh_token);
  //Debug command
  //console.log('[proxy] upstream body:', JSON.stringify(upstreamRes.data));

  // Return the upstream response to the app immediately — no added latency.
  res.status(upstreamRes.status).json(upstreamRes.data);

  // Fire-and-forget: import the RT into FA after returning the response.
  // Only runs in harvest mode (AUTH_PROVIDER=auth0) on successful token exchanges that include an RT.
  // Failures are logged but do not affect the response already sent to the app.
  if (
    AUTH_PROVIDER === 'auth0' &&
    upstreamRes.status === 200 &&
    upstreamRes.data.refresh_token
  ) {
    importToFA(upstreamRes.data).catch(err =>
      console.error('[import]', err.message)
    );
  }
});

// ─── Authorization redirect ───────────────────────────────────────────────────
// Passes the /authorize request through to whichever provider is active.
// Your app redirects to the proxy's /authorize; the proxy redirects to the real provider.
// Query params (client_id, redirect_uri, scope, state, etc.) are forwarded unchanged.

app.get('/authorize', (req, res) => {
  const upstream =
    AUTH_PROVIDER === 'fusionauth'
      ? `${FA_URL}/oauth2/authorize`
      : `https://${AUTH0_DOMAIN}/authorize`;

  const query = { ...req.query };
  if (AUTH_PROVIDER === 'fusionauth') {
    query.client_id = FA_APPLICATION_ID;
  }

  res.redirect(`${upstream}?${new URLSearchParams(query)}`);
});

// ─── Health check ─────────────────────────────────────────────────────────────
// Returns the active provider and current timestamp.
// Useful for confirming which mode the proxy is running in without checking env vars.

app.get('/health', (_req, res) => {
  res.json({ provider: AUTH_PROVIDER, timestamp: new Date().toISOString() });
});

// ─── RT import ────────────────────────────────────────────────────────────────
// Called after every successful Auth0 token exchange that returns a refresh token.
// Decodes the access token to get the user's email, looks them up in FA by email,
// then imports the RT so FA has it ready for when you cut over.
//
// Requirements:
//   1. The access token must contain an 'email' claim.
//      Add this Auth0 post-login Action if it doesn't:
//
//        exports.onExecutePostLogin = async (event, api) => {
//          api.accessToken.setCustomClaim('email', event.user.email);
//        };
//
//   2. The user must already exist in FusionAuth with the same email address.
//      Pre-migrate your users before opening the harvest window.

async function importToFA(tokenBody) {
  // Decode the AT (without verifying signature — we just need the email claim)
  const claims = jwt.decode(tokenBody.access_token);
  //Debug command
  //console.log('[debug] AT claims:', JSON.stringify(claims));
  const email = claims?.email;

  if (!email) {
    console.error('[import] no email claim in access token - add the Auth0 post-login Action described in the README');
    return;
  }

  const userId = await lookupFAUserByEmail(email);
  if (!userId) {
    console.warn(`[import] no FA user found for ${email} - make sure the user was migrated to FA before starting harvest`);
    return;
  }

  // Import the RT into FA. The token value is kept exactly as Auth0 issued it
  // so FA can recognize it when the app presents it after cutover.
  await axios.post(
    `${FA_URL}/api/user/refresh-token/import`,
    {
      // validateDbConstraints checks for duplicates and constraint violations.
      // Safe to enable in test/UAT; skip in production for performance.
      validateDbConstraints: IS_TEST_ENV === 'true',
      refreshTokens: [
        {
          token: tokenBody.refresh_token,
          userId,
          applicationId: FA_APPLICATION_ID,
          startInstant: Date.now(),
        },
      ],
    },
    {
      headers: {
        Authorization: FA_API_KEY,
        'X-FusionAuth-TenantId': FA_TENANT_ID,
        'Content-Type': 'application/json',
      },
    }
  );

  console.log(`[import] RT imported for ${email} (userId: ${userId})`);
}

// Looks up a FusionAuth user by email address and returns their FA user ID.
// Returns null if the user doesn't exist or the request fails.
async function lookupFAUserByEmail(email) {
  try {
    const res = await axios.get(`${FA_URL}/api/user`, {
      params: { email },
      headers: {
        Authorization: FA_API_KEY,
        'X-FusionAuth-TenantId': FA_TENANT_ID,
      },
      validateStatus: () => true,
    });

    if (res.status === 200 && res.data.user) {
      return res.data.user.id;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`RT Harvester Proxy running on :${PORT}`);
  console.log(`AUTH_PROVIDER=${AUTH_PROVIDER}`);
});