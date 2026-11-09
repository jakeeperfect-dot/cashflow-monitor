# KDCashflow
Standalone cash-in and cash-out monitoring for Kreme Donuts.

## Requirements
- Node.js 18 or newer
- No third-party npm packages required

## Run locally
1. Open a terminal in the project folder.
2. Run `npm start` (or `node server.js`).
3. Open http://127.0.0.1:3000.
4. On first launch, create the initial SuperAdmin account. Use a unique password with at least 12 characters.
5. Admins can create additional accounts from the Users page; only SuperAdmins can create another SuperAdmin account.

## Build and Netlify
The app can run on Netlify using a Netlify Function for the API and Supabase for persistent storage. The standalone `server.js` continues to support local use with `data.json`.

1. Create a Supabase project (for example, `kdcashmonitoring`) and run [`supabase/schema.sql`](./supabase/schema.sql) in its SQL Editor.
2. In Netlify, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the Supabase project settings. Keep the service-role key private; never add it to frontend code or commit it.
3. If you have existing local accounts or records to keep, set those same variables in your local shell and run `npm run migrate:supabase` once before deployment. The import does not print passwords or password hashes. Do not run it after users have begun using the deployed app, because it replaces the stored application state.
4. Deploy the site. Netlify runs `npm run build`, publishes `dist`, and routes `/api/*` requests to the function.

On the first deployment without an import, sign in by creating the initial SuperAdmin account. Keep regular backups; Supabase is now the source of truth for deployed data. Netlify's temporary function filesystem is not used for application data.

## Roles
- **SuperAdmin:** Access all features, including deleting individual transactions, resetting transaction data, and managing user accounts.
- **Admin:** View, add, and edit transactions; manage branches; create users, and delete Accountant and Branch Manager accounts. Cannot delete transactions or reset transaction data.
- **Accountant:** View all branches and transactions, add and request edits to transactions, and add branches. Transaction edits require Admin or SuperAdmin approval. Can view the Users page but cannot create or delete user accounts, delete transactions, remove branches, or reset transaction data.
- **Branch Manager:** View dashboard, branch, reconciliation, and transaction data for their assigned branch only, add transactions to that branch, and request edits to transactions in their branch. Transaction edits require Admin or SuperAdmin approval. Can view the Users page but cannot create or delete user accounts, delete transactions, or manage branches.

The server enforces access permissions for every API request. All signed-in users can change their own password after confirming their current password; passwords must be at least 12 characters. Changing a password signs out that user's other sessions. Passwords are stored as salted scrypt hashes. Login sessions use HttpOnly, SameSite cookies and expire after eight hours; sessions are cleared when the server restarts. Login attempts are rate-limited per client IP.

Accountant and Branch Manager transaction edits remain pending and do not change the live record until an Admin or SuperAdmin approves them. Pending requests disappear from the review queue after approval or rejection. The Transactions page includes a **Transaction History** button that opens the persistent history of transaction creation, edits, edit requests and decisions, deletions, and system resets. Previously saved edit requests are included in the history; older transaction actions cannot be reconstructed. A transaction that has changed since a request was submitted cannot be approved as-is.

The interface uses locally bundled Montserrat ExtraBold for display text and Montserrat Bold for body and UI text. Both weights are distributed under the SIL Open Font License; the license is in `public/fonts/OFL-Montserrat.txt`.

Admins can also delete Accountant and Branch Manager accounts from User management; SuperAdmins can additionally delete Admin accounts. SuperAdmin accounts are only visible to SuperAdmins in the user list. Downloading a transaction backup exports transaction records only; it does not contain user accounts or password hashes. Resetting transaction data permanently clears all transactions and transaction history while preserving users, branches, and pending edit request outcomes. The reset requires an explicit confirmation and is restricted to SuperAdmins.

Transactions, branch names, and password hashes are stored in `data.json`; back up this file regularly and restrict access to the project folder. Existing transaction history remains when a branch is removed. A Branch Manager assigned to a removed branch retains read-only access to that branch's transaction history.

By default, the server listens only on `127.0.0.1`. It does not terminate TLS. For other devices, put it behind a properly configured HTTPS reverse proxy, set `HOST=0.0.0.0` and `COOKIE_SECURE=true`, and restrict access with a firewall. Do not expose the built-in server directly to the public internet. Keep Node.js and the host system updated.
