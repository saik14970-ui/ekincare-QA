# Deploy to Vercel (step by step)

Needs: a GitHub account, a Vercel account, ~20 minutes.

## 1. Put the code on GitHub
1. github.com > New repository > name `ekincare-qa` > **Private** > Create.
2. Click "uploading an existing file". Drag in everything inside this folder:
   `api`, `lib`, `public`, `server.js`, `package.json`, `vercel.json`, `README.md`, `.env.example`.
   Do NOT upload `data.db` or any `.env` file. Click **Commit changes**.

## 2. Create the Vercel project
1. vercel.com > sign in with GitHub > **Add New > Project** > Import `ekincare-qa`.
2. Framework Preset: **Other**. Leave Build / Output settings empty. Click **Deploy**.

## 3. Add the database (required – Vercel has no permanent disk)
1. In the project: **Storage** tab > **Create Database** (Marketplace) > **Upstash Redis** > create > connect it to this project.
2. This adds the database variables automatically (KV_REST_API_URL / KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).

## 4. Environment variables (Project > Settings > Environment Variables)
| Name | Value |
|---|---|
| SESSION_SECRET | any long random text (40+ characters). Required. |
| CRON_SECRET | another long random text. Required for the 10 PM job. |
| BASE_URL | your address, e.g. https://ekincare-qa.vercel.app |
| ADMIN_EMAIL | saikiran.k@ekincare.com |
Later, for Microsoft sign-in and email (see README.md): TENANT_ID, CLIENT_ID, CLIENT_SECRET, MAIL_SENDER, EOD_TO, EOD_CC.
Then **Deployments > latest > ... > Redeploy**.

## 5. First use
Open your Vercel address > "Create Super Admin" > then add Auditor/TL logins and agents. Send everyone the same address.

## 6. Microsoft sign-in
IT registers the app with Redirect URI `https://YOUR-ADDRESS/auth/callback`, then add the values above and redeploy.

## 7. Daily 10 PM IST email
`vercel.json` already schedules `/api/cron/eod` at 16:30 UTC (= 22:00 IST). Vercel sends CRON_SECRET automatically.
Check your Vercel plan: on the free (Hobby) plan cron jobs can run only once a day and at an approximate time within the hour, so the email may not arrive exactly at 10:00 PM. Exact timing needs a paid plan. Also check Vercel's terms: the free plan is for personal, non-commercial use.

## Notes
- Data is stored in Upstash Redis. Check its free-tier limits and set up backups/exports there.
- A test version of this code was checked against a simulated Upstash service, not the real Vercel and Upstash.
- Local use still works: `node server.js` (uses data.db in this folder).
