# KDCashflow
Standalone cash-in and cash-out monitoring for Kreme Donuts.

## Requirements
- Node.js 18 or newer
- No third-party npm packages required

## Run locally
1. Open a terminal in the project folder.
2. Run `npm start` (or `node server.js`).
3. Open http://127.0.0.1:3000.
4. On first launch, create the initial Admin account. Use a unique password with at least 12 characters.
5. Admins can create additional accounts from the Users page.

## Roles
- **Admin:** View, add, edit, and delete transactions; manage branches; and create user accounts.
- **Accountant:** View all branches and transactions and add transactions. Cannot delete transactions or manage branches or users.
- **Branch Manager:** View dashboard, branch, reconciliation, and transaction data for their assigned branch only, and add transactions to that branch. Cannot edit or delete transactions or manage branches or users.

The server enforces access permissions for every API request. Passwords are stored as salted scrypt hashes. Login sessions use HttpOnly, SameSite cookies and expire after eight hours; sessions are cleared when the server restarts. Login attempts are rate-limited per client IP.

The interface uses locally bundled Montserrat ExtraBold for display text and Montserrat Bold for body and UI text. Both weights are distributed under the SIL Open Font License; the license is in `public/fonts/OFL-Montserrat.txt`.

Admins can also delete Accountant and Branch Manager accounts from User management. Downloading a transaction backup exports transaction records only; it does not contain user accounts or password hashes. Resetting transaction data permanently clears all transactions while preserving users and branches. The reset requires an explicit confirmation.

Transactions, branch names, and password hashes are stored in `data.json`; back up this file regularly and restrict access to the project folder. Existing transaction history remains when a branch is removed. A Branch Manager assigned to a removed branch retains read-only access to that branch's transaction history.

By default, the server listens only on `127.0.0.1`. It does not terminate TLS. For other devices, put it behind a properly configured HTTPS reverse proxy, set `HOST=0.0.0.0` and `COOKIE_SECURE=true`, and restrict access with a firewall. Do not expose the built-in server directly to the public internet. Keep Node.js and the host system updated.
