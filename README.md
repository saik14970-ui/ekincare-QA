# ekincare AI Auditor – setup guide

## 1. Run it
Requires Node.js 22.5 or newer. No npm install needed.
    cp .env.example .env     (then edit .env)
    node server.js
Open http://localhost:3000. The first visit shows "Create Super Admin" for ADMIN_EMAIL (8+ character password).
Keep it running 24/7 on a server (pm2, systemd, Azure App Service, etc.) behind HTTPS. The 10 PM IST email runs inside this process, so the server must stay on. Back up the data.db file daily.

## 2. Microsoft 365 (IT admin, about 15 minutes)
1. Entra admin centre > App registrations > New registration. Single tenant. Redirect URI (Web): BASE_URL/auth/callback
2. Copy Application (client) ID -> CLIENT_ID and Directory (tenant) ID -> TENANT_ID.
3. Certificates & secrets > New client secret -> CLIENT_SECRET (store only in .env).
4. API permissions > Microsoft Graph:
   - Delegated: openid, profile, email (Sign in with Microsoft)
   - Application: Mail.Send, then "Grant admin consent".
5. Recommended: restrict Mail.Send to the sender mailbox only (Exchange Online application access policy).
6. Restart the server. Settings & Logs shows "configured"; the Microsoft button turns on.
Microsoft sign-in only admits emails that the Super Admin has already added under Access Management.

## 3. Roles
Admin: everything. Auditor: assigned channels, own audits only. TL: only agents mapped to them in Agent Master (current mapping; historical audits stay intact).

## 4. Emails
- 0% / 100% audit: sent to the agent's Agent Master email right after saving (toggle in Settings). One email per audit (duplicate-proof).
- Daily summary: 10:00 PM IST to EOD_TO, cc EOD_CC; skipped if no audits were submitted that day; one per day. "Send today's EOD summary now" tests it.
- Every attempt (sent / skipped / failed + reason) is in Settings & Logs.

## 5. Test data
Use a separate copy (DB_FILE=/tmp/test.db node server.js) for trials so test audits never mix with production.
