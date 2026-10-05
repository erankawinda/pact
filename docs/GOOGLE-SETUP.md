# Google sign-in setup

Pact uses Supabase Auth with Google OAuth and PKCE. Its database operations require a verified Google identity. Configure your own Google Cloud and Supabase projects; the placeholders below are not working credentials.

## Google Auth Platform

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) in your own project. Configure app branding and your support/contact details.
2. Choose the audience appropriate to your users. For development with personal accounts, configure an External audience and add your test accounts if the app is in Testing.
3. Request identity scopes only: `openid`, `userinfo.email` and `userinfo.profile`.
4. Create a **Web application** OAuth client. Add `http://localhost:5173` as a development JavaScript origin and your actual deployed origin when ready.
5. Add your Supabase callback URL as the authorised redirect URI:

   ```text
   https://YOUR_PROJECT.supabase.co/auth/v1/callback
   ```

   Copy the actual value from the Supabase Google provider page; a custom Auth domain changes it.
6. Enter the Google client ID and client secret directly in **Supabase → Authentication → Sign In / Providers → Google**, and enable Google. Keep nonce checks enabled.

The client secret belongs in Supabase's provider configuration, never in `VITE_` variables, Git or frontend code. See [Supabase's Google provider guide](https://supabase.com/docs/guides/auth/social-login/auth-google).

## Supabase Auth settings

Enable new user signups so invited people can sign in for the first time. The current app is Google-only; leave anonymous sign-in and unused login providers disabled.

In Authentication URL Configuration:

| Setting | Development | Deployed app |
|---|---|---|
| Site URL | `http://localhost:5173/` | Your actual HTTPS app origin, ending in `/` |
| Allowed redirect URL | `http://localhost:5173/` | The same exact HTTPS app URL |

If one development project serves both local and hosted previews, keep the deployed Site URL and explicitly allow both return URLs. Pact requests `location.origin + '/'` after sign-in, so the browser origin and allow list must match. Prefer exact production entries over broad wildcards. See [Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls).

## Verify the complete flow

1. Use [DEPLOYMENT.md](DEPLOYMENT.md) to configure the frontend with your Supabase project's URL and publishable key.
2. Sign in from the configured origin. Confirm Account shows the intended identity, then create a test household.
3. Create a personal invitation for a second test account. Open it in another browser session, sign in with that matching account and accept it.
4. Test selecting the wrong Google account, switching accounts and accepting the preserved invitation.

Google sign-in establishes identity; accepting the invitation grants household membership. A successful login alone does not prove sharing, access restrictions or Realtime delivery work. See the two-phone checklist in [DEPLOYMENT.md](DEPLOYMENT.md).
