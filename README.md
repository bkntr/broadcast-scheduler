# Broadcast Scheduler

Broadcast Scheduler is a bilingual static Svelte web app for reviewing and
creating recurring YouTube Live broadcasts. It runs entirely in the browser
and can be deployed to Netlify without a backend.

One Google Cloud project and one Web application OAuth client belong to the
site owner. Every allowed user connects through that same public client ID but
receives a separate, short-lived access token for their own Google account.

## Security and browser storage

The public OAuth client ID is compiled into the site through
`VITE_GOOGLE_CLIENT_ID`. A client ID is not a secret. Never deploy the downloaded
OAuth JSON or its `client_secret`.

IndexedDB stores app settings, scheduling history, reusable YouTube stream IDs,
and thumbnail blobs needed to resume an interrupted batch. Google access tokens
and YouTube stream keys remain in memory only. Users normally need to reconnect
after refreshing the page.

Browser data is local to that origin, browser, and device. Keep the tab open
while a batch is creating broadcasts. If it closes or refreshes, step-by-step
progress is recovered as a Paused batch that can be resumed after reconnecting.

## Complete first-time setup

The order matters because Google needs the final Netlify origin before you
create the OAuth client.

### 1. Create the initial Netlify site

1. Push this repository to GitHub, GitLab, or Bitbucket.
2. In Netlify, choose **Add new site** → **Import an existing project**.
3. Select the repository and branch.
4. Netlify reads `netlify.toml` automatically. Confirm:

   ```text
   Build command: npm run build
   Publish directory: dist
   ```

5. Deploy the site. The first deployment can be unconfigured; it will show an
   owner-setup message instead of a Google login button.
6. Under **Domain management**, choose the permanent Netlify site name or add
   the custom domain you will use.
7. Copy the exact origin, without a path or trailing slash. For example:

   ```text
   https://your-scheduler.netlify.app
   ```

Use the stable production URL. Google does not support wildcard JavaScript
origins, so changing Netlify deploy-preview URLs are unsuitable for OAuth.

### 2. Configure the Google Auth Platform

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or
   select the project that will own the app and its YouTube API quota.
2. Open **APIs & Services** → **Library**, find **YouTube Data API v3**, and
   enable it.
3. Open **Google Auth Platform** and complete **Branding**:
   - use an app name users will recognize, such as `Broadcast Scheduler`;
   - select your user-support email; and
   - provide the developer contact email.
4. Under **Audience**, select **External** unless this is an internal Google
   Workspace application.
5. Leave **Publishing status** as **Testing** while using the test-user list.
6. Under **Data Access**, add this scope:

   ```text
   https://www.googleapis.com/auth/youtube.force-ssl
   ```

This scope is required to create and manage the user's YouTube broadcasts,
streams, playlists, and thumbnails.

### 3. Add test users

1. In **Google Auth Platform** → **Audience**, find **Test users**.
2. Choose **Add users**.
3. Add the Google email address for every person who will connect a YouTube
   channel, including your own account.
4. Save the list.

These emails are attached to the OAuth app—not to a token. Each person signs in
with their own listed Google account and authorizes only that account's YouTube
channels. Add new testers here before they try to connect.

### 4. Create and download the Web OAuth JSON

1. In **Google Auth Platform** → **Clients**, choose **Create client**.
2. Select **Web application**. Do not select Desktop app.
3. Give it a recognizable name, such as `Broadcast Scheduler Web`.
4. Under **Authorized JavaScript origins**, add the stable origin copied from
   Netlify:

   ```text
   https://your-scheduler.netlify.app
   ```

5. If local Google login is needed, also add:

   ```text
   http://localhost:5173
   ```

6. No Authorized redirect URI is required for this app's Google Identity
   Services popup token flow.
7. Create the client and choose **Download JSON**.

The downloaded file resembles:

```json
{
  "web": {
    "client_id": "123456789-example.apps.googleusercontent.com",
    "client_secret": "GOCSPX-do-not-deploy-this",
    "javascript_origins": ["https://your-scheduler.netlify.app"]
  }
}
```

Do not put this JSON anywhere in the repository, Netlify publish directory, or
browser. Keep it outside the project as an owner backup, or delete it after
copying `web.client_id`. The app uses only `web.client_id`.

### 5. Configure Netlify and redeploy

1. In Netlify, open the site and go to **Project configuration** →
   **Environment variables**.
2. Add:

   ```text
   Key: VITE_GOOGLE_CLIENT_ID
   Value: 123456789-example.apps.googleusercontent.com
   ```

   Use the exact `web.client_id` value from the JSON—not `client_secret`.
3. Make the variable available to builds. It does not need to be marked secret:
   Vite intentionally embeds this public client ID in the browser bundle.
4. Trigger a new production deployment from **Deploys** → **Trigger deploy**.
5. Open the production URL. The owner-setup message should now be replaced by
   **Connect YouTube**.

If the domain changes later, add the new exact origin to the same Google OAuth
client and redeploy if the client ID itself changed.

### 6. Connect and test

1. Open the deployed site in a normal browser window.
2. Click **Connect YouTube**.
3. Sign in with an account listed under **Test users** and approve access.
4. Select the intended channel if that Google account manages multiple YouTube
   channels.
5. Create one disposable **Private** broadcast first and verify it in YouTube
   Studio before scheduling a larger batch.

If Google reports `origin_mismatch`, compare the browser origin exactly with
the OAuth client's Authorized JavaScript origin, including `https` and the
subdomain. Google Cloud changes can take a few minutes to propagate.

## Local development

Install dependencies with Node.js 24:

```bash
npm install
```

Copy the example environment file and replace the value with `web.client_id`:

```bash
cp .env.example .env.local
npm run dev
```

`.env.local` is ignored by Git. Never add `client_secret` or the downloaded JSON
to it. Open `http://localhost:5173`, which must also be an Authorized JavaScript
origin if you want to test Google login locally.

Run all checks and create the production bundle with:

```bash
npm run build
```

The production files are emitted to `dist/`.

## Operational notes

- All users share the Google Cloud project's YouTube API quota.
- Test users do not share tokens or YouTube access with one another.
- OAuth configuration and scheduling history do not synchronize across devices.
- Clearing browser site data does not delete broadcasts already on YouTube.
- A public production app using this sensitive YouTube scope may require Google
  OAuth verification, a verified domain, a public homepage, and a privacy
  policy. Keep the app in Testing for the explicitly listed small test group.

## Development UI fixtures

UI fixtures do not require Google login, for example:

```text
http://localhost:5173/?fixture=review&locale=fr&theme=dark
```

Fixture names include `auth`, `reconnect`, `schedule`, `review`, `large`, `progress`,
`success`, `history`, `settings`, `description`, and `error`.

## License

Copyright (c) 2026 Ben Kantor. Released under the [MIT License](LICENSE).
