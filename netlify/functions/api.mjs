import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'kdcashflow_session';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 12;
const ROLES = new Set(['SuperAdmin', 'Admin', 'Accountant', 'Branch Manager']);
let supabase;

function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Netlify is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return supabase;
}

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Strict-Transport-Security': 'max-age=31536000',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function cookie(value, secure, maxAge) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function getCookie(header = '') {
  const entry = header.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : '';
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, branch: user.branch || null };
}

function isSuperAdmin(user) {
  return user.role === 'SuperAdmin';
}

function isAdmin(user) {
  return user.role === 'Admin' || isSuperAdmin(user);
}

function canCreateTransactions(user) {
  return isAdmin(user) || user.role === 'Accountant' || user.role === 'Branch Manager';
}

function canEditTransactions(user) {
  return isAdmin(user) || user.role === 'Accountant' || user.role === 'Branch Manager';
}

function validUsername(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{3,32}$/.test(value);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validOrigin(headers) {
  if (!headers.origin || !headers.host) return false;
  try {
    return new URL(headers.origin).host.toLowerCase() === headers.host.toLowerCase();
  } catch {
    return false;
  }
}

function getPath(event) {
  const url = new URL(event.rawUrl || `https://${event.headers.host}${event.path}`);
  if (url.pathname.startsWith('/api/')) return { pathname: url.pathname, url };
  const functionPrefix = '/.netlify/functions/api';
  if (url.pathname.startsWith(`${functionPrefix}/`)) {
    url.pathname = `/api/${url.pathname.slice(functionPrefix.length + 1)}`;
  } else if (url.pathname === functionPrefix) {
    url.pathname = '/api/';
  }
  return { pathname: url.pathname, url };
}

function parseBody(event) {
  if (!event.body) return {};
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (Buffer.byteLength(body) > 1024 * 1024) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error('Invalid JSON request.'), { status: 400 });
  }
}

async function readState() {
  const { data, error } = await getSupabase()
    .from('kdcashflow_state')
    .select('version,payload')
    .eq('id', 'primary')
    .single();
  if (error) throw new Error(`Unable to load KDCashflow data: ${error.message}`);
  if (!data || !data.payload || !Array.isArray(data.payload.branches) || !Array.isArray(data.payload.users)) {
    throw new Error('Supabase KDCashflow state is invalid. Run the provided schema.');
  }
  return { version: data.version, payload: data.payload };
}

async function updateState(mutator) {
  const client = getSupabase();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await readState();
    const result = await mutator(snapshot.payload);
    if (!result.commit) return result.response;
    const { data, error } = await client.rpc('kdcashflow_compare_and_set_state', {
      p_expected_version: snapshot.version,
      p_payload: snapshot.payload,
    });
    if (error) throw new Error(`Unable to save KDCashflow data: ${error.message}`);
    if (data === true) return result.response;
  }
  return response(409, { error: 'Another update was saved at the same time. Please retry your request.' });
}

async function makePasswordHash(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [saltHex, hashHex] = String(storedHash || '').split(':');
  if (!/^[\da-f]{32}$/i.test(saltHex || '') || !/^[\da-f]{128}$/i.test(hashHex || '')) {
    await scrypt(password, 'kdcashflow-invalid-user', 64, { N: 16384, r: 8, p: 1 });
    return false;
  }
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, Buffer.from(hashHex, 'hex'));
}

async function loginRateLimit(action, ipHash) {
  const { data, error } = await getSupabase().rpc(`kdcashflow_${action}`, { p_ip_hash: ipHash });
  if (error) throw new Error(`Unable to check login rate limit: ${error.message}`);
  return data;
}

function recordTransactionHistory(data, user, entry) {
  data.transactionHistory.push({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    actor: user.username,
    actorRole: user.role,
    ...entry,
  });
}

async function authenticatedUser(event, state) {
  const token = getCookie(event.headers.cookie || '');
  if (!token) return null;
  const tokenHash = hashToken(token);
  const client = getSupabase();
  const { data: session, error } = await client
    .from('kdcashflow_sessions')
    .select('user_id,expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) throw new Error(`Unable to load session: ${error.message}`);
  if (!session || Date.parse(session.expires_at) <= Date.now()) {
    if (session) {
      const { error: deleteError } = await client.from('kdcashflow_sessions').delete().eq('token_hash', tokenHash);
      if (deleteError) throw new Error(`Unable to clear expired session: ${deleteError.message}`);
    }
    return null;
  }
  const user = state.users.find(account => account.id === session.user_id);
  if (!user) {
    const { error: deleteError } = await client.from('kdcashflow_sessions').delete().eq('token_hash', tokenHash);
    if (deleteError) throw new Error(`Unable to clear invalid session: ${deleteError.message}`);
    return null;
  }
  const expiresAt = new Date(Date.now() + SESSION_TTL).toISOString();
  const { error: updateError } = await client
    .from('kdcashflow_sessions')
    .update({ expires_at: expiresAt })
    .eq('token_hash', tokenHash);
  if (updateError) throw new Error(`Unable to refresh session: ${updateError.message}`);
  return { user, token, tokenHash };
}

async function createSession(user, secure) {
  const token = randomBytes(32).toString('hex');
  const { error } = await getSupabase().from('kdcashflow_sessions').insert({
    token_hash: hashToken(token),
    user_id: user.id,
    expires_at: new Date(Date.now() + SESSION_TTL).toISOString(),
  });
  if (error) throw new Error(`Unable to create session: ${error.message}`);
  return { 'Set-Cookie': cookie(token, secure, SESSION_TTL / 1000) };
}

function isJsonRequest(headers) {
  return headers['content-type']?.toLowerCase().split(';')[0].trim() === 'application/json';
}

export async function handler(event) {
  const method = event.httpMethod || 'GET';
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const secure = headers['x-forwarded-proto'] === 'https' || process.env.CONTEXT === 'production' || process.env.CONTEXT === 'deploy-preview';
  let pathname;
  let url;

  try {
    ({ pathname, url } = getPath(event));
    if (!pathname.startsWith('/api/')) return response(404, { error: 'Not found.' });
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
      return response(405, { error: 'Method not allowed.' }, { Allow: 'GET, POST, PATCH, DELETE' });
    }

    if (pathname === '/api/setup-status' && method === 'GET') {
      const { payload } = await readState();
      return response(200, { setupRequired: payload.users.length === 0 });
    }

    if (pathname === '/api/setup' && method === 'POST') {
      if (!validOrigin(headers)) return response(403, { error: 'Request origin is not allowed.' });
      if (!isJsonRequest(headers)) return response(415, { error: 'Content-Type must be application/json.' });
      const input = parseBody(event);
      if (!validUsername(input.username)) return response(400, { error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.' });
      if (typeof input.password !== 'string' || input.password.length < PASSWORD_MIN_LENGTH) return response(400, { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
      if (input.password.length > 128) return response(400, { error: 'Password must be 128 characters or fewer.' });
      const user = {
        id: randomUUID(),
        username: input.username.toLowerCase(),
        role: 'SuperAdmin',
        branch: null,
        passwordHash: await makePasswordHash(input.password),
      };
      const setupResult = await updateState(data => {
        if (data.users.length) return { commit: false, response: response(409, { error: 'Initial setup is already complete.' }) };
        data.users.push(user);
        return { commit: true, response: response(201, { user: publicUser(user) }) };
      });
      if (setupResult.statusCode !== 201) return setupResult;
      const sessionHeaders = await createSession(user, secure);
      return response(201, { user: publicUser(user) }, sessionHeaders);
    }

    if (pathname === '/api/login' && method === 'POST') {
      if (!validOrigin(headers)) return response(403, { error: 'Request origin is not allowed.' });
      if (!isJsonRequest(headers)) return response(415, { error: 'Content-Type must be application/json.' });
      const ip = headers['x-nf-client-connection-ip'] || headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
      const ipHash = hashToken(ip);
      if (!await loginRateLimit('begin_login_attempt', ipHash)) return response(429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
      const input = parseBody(event);
      const { payload } = await readState();
      if (!payload.users.length) return response(409, { error: 'Create the first administrator account to get started.' });
      const username = typeof input.username === 'string' ? input.username.toLowerCase() : '';
      const user = payload.users.find(account => account.username === username);
      const password = typeof input.password === 'string' && input.password.length <= 128 ? input.password : '';
      const valid = await verifyPassword(password, user?.passwordHash);
      if (!user || !valid) return response(401, { error: 'Invalid username or password.' });
      await loginRateLimit('reset_login_attempts', ipHash);
      const sessionHeaders = await createSession(user, secure);
      return response(200, { user: publicUser(user) }, sessionHeaders);
    }

    if (pathname === '/api/logout' && method === 'POST') {
      const token = getCookie(headers.cookie || '');
      if (token) {
        const { error } = await getSupabase().from('kdcashflow_sessions').delete().eq('token_hash', hashToken(token));
        if (error) throw new Error(`Unable to end session: ${error.message}`);
      }
      return response(200, { ok: true }, { 'Set-Cookie': cookie('', secure, 0) });
    }

    if (!pathname.startsWith('/api/')) return response(404, { error: 'Not found.' });
    const state = await readState();
    const auth = await authenticatedUser(event, state.payload);
    if (!auth) return response(401, { error: 'Please sign in to continue.' });
    const { user, token, tokenHash } = auth;

    const mutatingRoute = method === 'POST' && ['/api/change-password', '/api/users', '/api/transactions', '/api/branches'].includes(pathname)
      || method === 'PATCH' && (pathname.startsWith('/api/transactions/') || pathname.startsWith('/api/transaction-edit-requests/'))
      || method === 'DELETE' && (pathname === '/api/transactions' || pathname.startsWith('/api/transactions/') || pathname === '/api/branches' || pathname.startsWith('/api/users/'));
    if (mutatingRoute) {
      if (!validOrigin(headers)) return response(403, { error: 'Request origin is not allowed.' });
      if (!isJsonRequest(headers)) return response(415, { error: 'Content-Type must be application/json.' });
    }

    if (pathname === '/api/session' && method === 'GET') return response(200, { user: publicUser(user) });

    if (pathname === '/api/change-password' && method === 'POST') {
      const input = parseBody(event);
      if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 128) return response(400, { error: 'Enter your current password.' });
      if (typeof input.newPassword !== 'string' || input.newPassword.length < PASSWORD_MIN_LENGTH) return response(400, { error: `New password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
      if (input.newPassword.length > 128) return response(400, { error: 'New password must be 128 characters or fewer.' });
      const account = state.payload.users.find(existing => existing.id === user.id);
      if (!account || !(await verifyPassword(input.currentPassword, account.passwordHash))) return response(401, { error: 'Current password is incorrect.' });
      const passwordHash = await makePasswordHash(input.newPassword);
      const result = await updateState(data => {
        const current = data.users.find(existing => existing.id === user.id);
        if (!current) return { commit: false, response: response(401, { error: 'Please sign in to continue.' }) };
        current.passwordHash = passwordHash;
        return { commit: true, response: response(200, { ok: true }) };
      });
      if (result.statusCode !== 200) return result;
      const client = getSupabase();
      const expiresAt = new Date(Date.now() + SESSION_TTL).toISOString();
      const { error: deleteError } = await client.from('kdcashflow_sessions').delete().eq('user_id', user.id);
      if (deleteError) throw new Error(`Unable to clear old sessions: ${deleteError.message}`);
      const { error: insertError } = await client.from('kdcashflow_sessions').insert({ token_hash: tokenHash, user_id: user.id, expires_at: expiresAt });
      if (insertError) throw new Error(`Unable to refresh current session: ${insertError.message}`);
      return response(200, { ok: true }, { 'Set-Cookie': cookie(token, secure, SESSION_TTL / 1000) });
    }

    if (pathname === '/api/data' && method === 'GET') {
      const branches = user.role === 'Branch Manager' ? [user.branch] : state.payload.branches;
      const transactions = user.role === 'Branch Manager'
        ? state.payload.transactions.filter(transaction => transaction.branch === user.branch)
        : state.payload.transactions;
      return response(200, { branches, transactions });
    }

    if (pathname === '/api/transaction-edit-requests' && method === 'GET') {
      const requests = isAdmin(user)
        ? state.payload.transactionEditRequests.filter(request => request.status === 'Pending')
        : state.payload.transactionEditRequests.filter(request => request.requestedBy === user.id && request.status === 'Pending');
      return response(200, { requests });
    }

    if (pathname === '/api/transaction-history' && method === 'GET') {
      const history = user.role === 'Branch Manager'
        ? state.payload.transactionHistory.filter(entry => entry.branch === user.branch
          || entry.before?.branch === user.branch
          || entry.after?.branch === user.branch)
        : state.payload.transactionHistory;
      return response(200, { history: history.slice().reverse() });
    }

    if (pathname.startsWith('/api/transaction-edit-requests/') && method === 'PATCH') {
      if (!isAdmin(user)) return response(403, { error: 'Only Admins can review transaction edit requests.' });
      const id = decodeURIComponent(pathname.slice('/api/transaction-edit-requests/'.length));
      const input = parseBody(event);
      if (!['approve', 'reject'].includes(input.action)) return response(400, { error: 'Choose approve or reject.' });
      return updateState(data => {
        const editRequest = data.transactionEditRequests.find(request => request.id === id);
        if (!editRequest) return { commit: false, response: response(404, { error: 'Edit request not found.' }) };
        if (editRequest.status !== 'Pending') return { commit: false, response: response(409, { error: 'This edit request has already been reviewed.' }) };
        if (input.action === 'approve') {
          const transaction = data.transactions.find(item => item.id === editRequest.transactionId);
          if (!transaction) return { commit: false, response: response(409, { error: 'The transaction no longer exists. Reject this request instead.' }) };
          if ((transaction.updatedAt || transaction.createdAt || null) !== editRequest.baseUpdatedAt) return { commit: false, response: response(409, { error: 'The transaction changed after this request was submitted. Reject this stale request.' }) };
          Object.assign(transaction, editRequest.changes, { updatedAt: new Date().toISOString() });
          editRequest.status = 'Approved';
          recordTransactionHistory(data, user, {
            transactionId: editRequest.transactionId, branch: transaction.branch, action: 'Edit approved',
            before: editRequest.original, after: editRequest.changes, requestedBy: editRequest.requesterName,
          });
        } else {
          editRequest.status = 'Rejected';
          recordTransactionHistory(data, user, {
            transactionId: editRequest.transactionId, branch: editRequest.original.branch, action: 'Edit rejected',
            before: editRequest.original, after: editRequest.changes, requestedBy: editRequest.requesterName,
          });
        }
        editRequest.reviewedAt = new Date().toISOString();
        editRequest.reviewedBy = user.username;
        return { commit: true, response: response(200, { request: editRequest }) };
      });
    }

    if (pathname === '/api/users' && method === 'GET') {
      const visibleUsers = isSuperAdmin(user)
        ? state.payload.users
        : state.payload.users.filter(account => account.role !== 'SuperAdmin');
      return response(200, { users: visibleUsers.map(publicUser) });
    }

    if (pathname === '/api/users' && method === 'POST') {
      if (!isAdmin(user)) return response(403, { error: 'Only Admins can create users.' });
      const input = parseBody(event);
      const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
      if (!validUsername(username)) return response(400, { error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.' });
      if (typeof input.password !== 'string' || input.password.length < PASSWORD_MIN_LENGTH) return response(400, { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
      if (input.password.length > 128) return response(400, { error: 'Password must be 128 characters or fewer.' });
      if (!ROLES.has(input.role)) return response(400, { error: 'Choose a valid role.' });
      if (input.role === 'SuperAdmin' && !isSuperAdmin(user)) return response(403, { error: 'Only SuperAdmins can create SuperAdmin accounts.' });
      const branch = input.role === 'Branch Manager' ? input.branch : null;
      const passwordHash = await makePasswordHash(input.password);
      const account = { id: randomUUID(), username, role: input.role, branch, passwordHash };
      return updateState(data => {
        if (data.users.some(existing => existing.username === username)) return { commit: false, response: response(409, { error: 'That username already exists.' }) };
        if (input.role === 'Branch Manager' && !data.branches.includes(branch)) return { commit: false, response: response(400, { error: 'Choose an active branch for this Branch Manager.' }) };
        data.users.push(account);
        return { commit: true, response: response(201, { user: publicUser(account) }) };
      });
    }

    if (pathname.startsWith('/api/users/') && method === 'DELETE') {
      if (!isAdmin(user)) return response(403, { error: 'Only Admins can delete users.' });
      const id = decodeURIComponent(pathname.slice('/api/users/'.length));
      const result = await updateState(data => {
        const account = data.users.find(existing => existing.id === id);
        if (!account) return { commit: false, response: response(404, { error: 'User not found.' }) };
        if (account.role === 'SuperAdmin' || account.role === 'Admin' && !isSuperAdmin(user)) return { commit: false, response: response(403, { error: 'You cannot delete this account.' }) };
        data.users = data.users.filter(existing => existing.id !== id);
        return { commit: true, response: response(200, { ok: true }) };
      });
      if (result.statusCode !== 200) return result;
      const { error } = await getSupabase().from('kdcashflow_sessions').delete().eq('user_id', id);
      if (error) throw new Error(`Unable to clear deleted user's sessions: ${error.message}`);
      return result;
    }

    if (pathname === '/api/transactions/backup' && method === 'GET') {
      if (!isAdmin(user)) return response(403, { error: 'Only Admins can back up transaction data.' });
      const exportedAt = new Date().toISOString();
      return response(200, { exportedAt, transactions: state.payload.transactions }, {
        'Content-Disposition': `attachment; filename="KDCashflow-transactions-${exportedAt.slice(0, 10)}.json"`,
      });
    }

    if (pathname === '/api/transactions' && method === 'DELETE') {
      if (!isSuperAdmin(user)) return response(403, { error: 'Only SuperAdmins can reset transaction data.' });
      return updateState(data => {
        const deletedCount = data.transactions.length;
        for (const editRequest of data.transactionEditRequests.filter(request => request.status === 'Pending')) {
          editRequest.status = 'Rejected';
          editRequest.reviewedAt = new Date().toISOString();
          editRequest.reviewedBy = user.username;
        }
        const historyDeletedCount = data.transactionHistory.length;
        data.transactions = [];
        data.transactionHistory = [];
        return { commit: true, response: response(200, { ok: true, deletedCount, historyDeletedCount }) };
      });
    }

    if (pathname === '/api/transactions' && method === 'POST') {
      if (!canCreateTransactions(user)) return response(403, { error: 'You do not have permission to add transactions.' });
      const input = parseBody(event);
      const branch = user.role === 'Branch Manager' ? user.branch : input.branch;
      if (!['in', 'out'].includes(input.type) || typeof branch !== 'string' || !state.payload.branches.includes(branch)
          || typeof input.category !== 'string' || !input.category.trim()
          || !Number.isFinite(Number(input.amount)) || !(Number(input.amount) > 0) || !validDate(input.date)) {
        return response(400, { error: 'Please complete all required fields and enter a valid amount and date.' });
      }
      return updateState(data => {
        if (!data.branches.includes(branch)) return { commit: false, response: response(400, { error: 'Choose an active branch.' }) };
        const transaction = {
          id: randomUUID(), type: input.type, branch, category: input.category.trim(),
          amount: Number(input.amount), date: input.date,
          reference: String(input.reference || '').slice(0, 200),
          notes: String(input.notes || '').slice(0, 1000), createdAt: new Date().toISOString(),
        };
        data.transactions.unshift(transaction);
        recordTransactionHistory(data, user, { transactionId: transaction.id, branch, action: 'Created', after: transaction });
        return { commit: true, response: response(201, transaction) };
      });
    }

    if (pathname.startsWith('/api/transactions/') && method === 'DELETE') {
      if (!isSuperAdmin(user)) return response(403, { error: 'Only SuperAdmins can delete transactions.' });
      const id = decodeURIComponent(pathname.slice('/api/transactions/'.length));
      return updateState(data => {
        const index = data.transactions.findIndex(transaction => transaction.id === id);
        if (index < 0) return { commit: false, response: response(404, { error: 'Transaction not found.' }) };
        const [transaction] = data.transactions.splice(index, 1);
        recordTransactionHistory(data, user, { transactionId: id, branch: transaction.branch, action: 'Deleted', before: transaction });
        for (const editRequest of data.transactionEditRequests.filter(request => request.transactionId === id && request.status === 'Pending')) {
          editRequest.status = 'Rejected';
          editRequest.reviewedAt = new Date().toISOString();
          editRequest.reviewedBy = user.username;
          recordTransactionHistory(data, user, {
            transactionId: id, branch: transaction.branch, action: 'Edit request invalidated by transaction deletion',
            before: editRequest.original, after: editRequest.changes, requestedBy: editRequest.requesterName,
          });
        }
        return { commit: true, response: response(200, { ok: true }) };
      });
    }

    if (pathname.startsWith('/api/transactions/') && method === 'PATCH') {
      if (!canEditTransactions(user)) return response(403, { error: 'You do not have permission to edit transactions.' });
      const id = decodeURIComponent(pathname.slice('/api/transactions/'.length));
      const input = parseBody(event);
      return updateState(data => {
        const index = data.transactions.findIndex(transaction => transaction.id === id);
        if (index < 0) return { commit: false, response: response(404, { error: 'Transaction not found.' }) };
        const existing = data.transactions[index];
        if (user.role === 'Branch Manager' && (existing.branch !== user.branch || input.branch !== user.branch)) return { commit: false, response: response(403, { error: 'You can only edit transactions for your assigned branch.' }) };
        if (!['in', 'out'].includes(input.type) || typeof input.branch !== 'string'
            || (!data.branches.includes(input.branch) && input.branch !== existing.branch)
            || typeof input.category !== 'string' || !input.category.trim()
            || !Number.isFinite(Number(input.amount)) || !(Number(input.amount) > 0) || !validDate(input.date)) {
          return { commit: false, response: response(400, { error: 'Please complete all required fields and enter a valid amount and date.' }) };
        }
        const changes = {
          type: input.type, branch: input.branch, date: input.date, category: input.category.trim(),
          amount: Number(input.amount), reference: String(input.reference || '').slice(0, 200),
          notes: String(input.notes || '').slice(0, 1000),
        };
        if (!isAdmin(user)) {
          if (data.transactionEditRequests.some(request => request.transactionId === id && request.status === 'Pending')) return { commit: false, response: response(409, { error: 'This transaction already has a pending edit request.' }) };
          const editRequest = {
            id: randomUUID(), transactionId: id, requestedBy: user.id, requesterName: user.username,
            status: 'Pending', baseUpdatedAt: existing.updatedAt || existing.createdAt || null,
            original: Object.fromEntries(Object.keys(changes).map(key => [key, existing[key] ?? ''])),
            changes, requestedAt: new Date().toISOString(),
          };
          data.transactionEditRequests.push(editRequest);
          recordTransactionHistory(data, user, {
            transactionId: id, branch: existing.branch, action: 'Edit requested',
            before: editRequest.original, after: changes, requestId: editRequest.id,
          });
          return { commit: true, response: response(202, { request: editRequest }) };
        }
        data.transactions[index] = { ...existing, ...changes, updatedAt: new Date().toISOString() };
        recordTransactionHistory(data, user, {
          transactionId: id, branch: data.transactions[index].branch, action: 'Edited',
          before: existing, after: data.transactions[index],
        });
        return { commit: true, response: response(200, data.transactions[index]) };
      });
    }

    if (pathname === '/api/branches' && method === 'POST') {
      if (!isAdmin(user) && user.role !== 'Accountant') return response(403, { error: 'Only Admins and Accountants can add branches.' });
      const input = parseBody(event);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 80) return response(400, { error: 'Branch name must be between 1 and 80 characters.' });
      return updateState(data => {
        if (data.branches.some(branch => branch.toLowerCase() === name.toLowerCase())) return { commit: false, response: response(409, { error: 'That branch already exists.' }) };
        data.branches.push(name);
        return { commit: true, response: response(201, { branches: data.branches }) };
      });
    }

    if (pathname === '/api/branches' && method === 'DELETE') {
      if (!isAdmin(user)) return response(403, { error: 'Only Admins can remove branches.' });
      const name = url.searchParams.get('name');
      if (!name) return response(400, { error: 'Branch name is required.' });
      return updateState(data => {
        if (!data.branches.includes(name)) return { commit: false, response: response(404, { error: 'Branch not found.' }) };
        data.branches = data.branches.filter(branch => branch !== name);
        return { commit: true, response: response(200, { ok: true }) };
      });
    }

    return response(404, { error: 'Not found.' });
  } catch (error) {
    if (error.status) return response(error.status, { error: error.message });
    console.error('KDCashflow API request failed:', error);
    return response(500, { error: 'The KDCashflow API could not complete the request. Check the Netlify Function and Supabase configuration.' });
  }
}
