'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const DATA = path.join(__dirname, 'data.json');
const PUBLIC = path.resolve(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SESSION_COOKIE = 'kdcashflow_session';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 12;
const ROLES = new Set(['SuperAdmin', 'Admin', 'Accountant', 'Branch Manager']);
const scrypt = promisify(crypto.scrypt);
const sessions = new Map();
const loginAttempts = new Map();
const initial = { branches: ['Kapatagan Main'], transactions: [], users: [], transactionEditRequests: [], transactionHistory: [] };

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    if (!Array.isArray(data.branches) || !Array.isArray(data.transactions)) {
      throw new Error('Invalid data.json structure.');
    }
    data.users = Array.isArray(data.users) ? data.users : [];
    data.transactionEditRequests = Array.isArray(data.transactionEditRequests) ? data.transactionEditRequests : [];
    if (!Array.isArray(data.transactionHistory)) {
      data.transactionHistory = data.transactionEditRequests.flatMap(request => {
        if (!request.id || !request.requestedAt || !request.requesterName) return [];
        const requester = data.users.find(account => account.id === request.requestedBy);
        const branch = request.original?.branch || request.changes?.branch || null;
        const entries = [{
          id: `legacy-request-${request.id}`,
          timestamp: request.requestedAt,
          actor: request.requesterName,
          actorRole: requester?.role || 'Unknown',
          transactionId: request.transactionId,
          branch,
          action: 'Edit requested',
          before: request.original,
          after: request.changes,
          requestId: request.id,
        }];
        if (['Approved', 'Rejected'].includes(request.status) && request.reviewedAt && request.reviewedBy) {
          const reviewer = data.users.find(account => account.username === request.reviewedBy);
          entries.push({
            id: `legacy-review-${request.id}`,
            timestamp: request.reviewedAt,
            actor: request.reviewedBy,
            actorRole: reviewer?.role || 'Unknown',
            transactionId: request.transactionId,
            branch,
            action: `Edit ${request.status.toLowerCase()}`,
            before: request.original,
            after: request.changes,
            requestedBy: request.requesterName,
          });
        }
        return entries;
      });
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(initial);
    throw error;
  }
}

function write(data) {
  const temporary = `${DATA}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, DATA);
}

function recordTransactionHistory(data, user, entry) {
  data.transactionHistory.push({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    actor: user.username,
    actorRole: user.role,
    ...entry,
  });
}

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function cookie(value, req, maxAge) {
  const secure = req.socket.encrypted || process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
}

function authenticate(req, res, db) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    send(res, 401, { error: 'Please sign in to continue.' });
    return null;
  }
  const user = db.users.find(account => account.id === session.userId);
  if (!user) {
    sessions.delete(token);
    send(res, 401, { error: 'Please sign in to continue.' });
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return user;
}

function isAdmin(user) {
  return user.role === 'Admin' || isSuperAdmin(user);
}

function isSuperAdmin(user) {
  return user.role === 'SuperAdmin';
}

function canCreateTransactions(user) {
  return isAdmin(user) || user.role === 'Accountant' || user.role === 'Branch Manager';
}

function canEditTransactions(user) {
  return isAdmin(user) || user.role === 'Accountant' || user.role === 'Branch Manager';
}

function validOrigin(req) {
  if (!req.headers.origin || !req.headers.host) return false;
  try {
    return new URL(req.headers.origin).host.toLowerCase() === req.headers.host.toLowerCase();
  } catch {
    return false;
  }
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  }
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('Invalid JSON request.'), { status: 400 });
    }
    return parsed;
  } catch {
    throw Object.assign(new Error('Invalid JSON request.'), { status: 400 });
  }
}

function validUsername(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{3,32}$/.test(value);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

async function makePasswordHash(password) {
  const salt = crypto.randomBytes(16);
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
  return crypto.timingSafeEqual(actual, Buffer.from(hashHex, 'hex'));
}

function loginAllowed(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.startedAt > 15 * 60 * 1000) {
    loginAttempts.set(ip, { startedAt: now, count: 0 });
    return true;
  }
  return entry.count < 10;
}

function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { startedAt: Date.now(), count: 0 };
  entry.count += 1;
  loginAttempts.set(ip, entry);
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, branch: user.branch || null };
}

function sendStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(PUBLIC, `.${pathname}`);
  if (file !== PUBLIC && !file.startsWith(`${PUBLIC}${path.sep}`)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (error, content) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500);
      return res.end(error.code === 'ENOENT' ? 'Not found' : 'Unable to read file');
    }
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.png': 'image/png',
      '.ttf': 'font/ttf',
    }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(content);
  });
}

async function handleApi(req, res, url) {
  const db = read();
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/setup-status' && method === 'GET') {
    return send(res, 200, { setupRequired: db.users.length === 0 });
  }

  if ((method === 'POST' && ['/api/setup', '/api/login', '/api/logout', '/api/change-password', '/api/users', '/api/transactions', '/api/branches'].includes(pathname)
      || method === 'PATCH' && (pathname.startsWith('/api/transactions/') || pathname.startsWith('/api/transaction-edit-requests/')))
      || method === 'DELETE' && (pathname === '/api/transactions' || pathname.startsWith('/api/transactions/') || pathname === '/api/branches' || pathname.startsWith('/api/users/'))) {
    if (!validOrigin(req)) return send(res, 403, { error: 'Request origin is not allowed.' });
    if (req.headers['content-type']?.toLowerCase().split(';')[0].trim() !== 'application/json') {
      return send(res, 415, { error: 'Content-Type must be application/json.' });
    }
  }

  if (pathname === '/api/setup' && method === 'POST') {
    if (db.users.length) return send(res, 409, { error: 'Initial setup is already complete.' });
    const input = await readJson(req);
    if (!validUsername(input.username)) return send(res, 400, { error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.' });
    if (typeof input.password !== 'string' || input.password.length < PASSWORD_MIN_LENGTH) {
      return send(res, 400, { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
    }
    if (input.password.length > 128) return send(res, 400, { error: 'Password must be 128 characters or fewer.' });
    const user = { id: crypto.randomUUID(), username: input.username.toLowerCase(), role: 'SuperAdmin', branch: null, passwordHash: await makePasswordHash(input.password) };
    if (read().users.length) return send(res, 409, { error: 'Initial setup is already complete.' });
    db.users.push(user);
    write(db);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });
    return send(res, 201, { user: publicUser(user) }, { 'Set-Cookie': cookie(token, req, SESSION_TTL / 1000) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (!db.users.length) return send(res, 409, { error: 'Create the first administrator account to get started.' });
    const ip = req.socket.remoteAddress || 'unknown';
    if (!loginAllowed(ip)) return send(res, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    const input = await readJson(req);
    const username = typeof input.username === 'string' ? input.username.toLowerCase() : '';
    const user = db.users.find(account => account.username === username);
    const password = typeof input.password === 'string' && input.password.length <= 128 ? input.password : '';
    const valid = await verifyPassword(password, user?.passwordHash);
    if (!user || !valid) {
      recordLoginFailure(ip);
      return send(res, 401, { error: 'Invalid username or password.' });
    }
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': cookie(token, req, SESSION_TTL / 1000) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', req, 0) });
  }

  if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
  const user = authenticate(req, res, db);
  if (!user) return;

  if (pathname === '/api/session' && method === 'GET') return send(res, 200, { user: publicUser(user) });

  if (pathname === '/api/change-password' && method === 'POST') {
    const input = await readJson(req);
    if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 128) {
      return send(res, 400, { error: 'Enter your current password.' });
    }
    if (typeof input.newPassword !== 'string' || input.newPassword.length < PASSWORD_MIN_LENGTH) {
      return send(res, 400, { error: `New password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
    }
    if (input.newPassword.length > 128) return send(res, 400, { error: 'New password must be 128 characters or fewer.' });

    const latest = read();
    const account = latest.users.find(existing => existing.id === user.id);
    if (!account || !(await verifyPassword(input.currentPassword, account.passwordHash))) {
      return send(res, 401, { error: 'Current password is incorrect.' });
    }
    account.passwordHash = await makePasswordHash(input.newPassword);
    write(latest);

    const currentToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    for (const [token, session] of sessions) {
      if (session.userId === account.id && token !== currentToken) sessions.delete(token);
    }
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/data' && method === 'GET') {
    const branches = user.role === 'Branch Manager' ? [user.branch] : db.branches;
    const transactions = user.role === 'Branch Manager'
      ? db.transactions.filter(transaction => transaction.branch === user.branch)
      : db.transactions;
    return send(res, 200, { branches, transactions });
  }

  if (pathname === '/api/transaction-edit-requests' && method === 'GET') {
    const requests = isAdmin(user)
      ? db.transactionEditRequests.filter(request => request.status === 'Pending')
      : db.transactionEditRequests.filter(request => request.requestedBy === user.id && request.status === 'Pending');
    return send(res, 200, { requests });
  }

  if (pathname === '/api/transaction-history' && method === 'GET') {
    const history = user.role === 'Branch Manager'
      ? db.transactionHistory.filter(entry => entry.branch === user.branch
        || entry.before?.branch === user.branch
        || entry.after?.branch === user.branch)
      : db.transactionHistory;
    return send(res, 200, { history: history.slice().reverse() });
  }

  if (pathname.startsWith('/api/transaction-edit-requests/') && method === 'PATCH') {
    if (!isAdmin(user)) return send(res, 403, { error: 'Only Admins can review transaction edit requests.' });
    const id = decodeURIComponent(pathname.slice('/api/transaction-edit-requests/'.length));
    const input = await readJson(req);
    if (!['approve', 'reject'].includes(input.action)) return send(res, 400, { error: 'Choose approve or reject.' });
    const latest = read();
    const editRequest = latest.transactionEditRequests.find(request => request.id === id);
    if (!editRequest) return send(res, 404, { error: 'Edit request not found.' });
    if (editRequest.status !== 'Pending') return send(res, 409, { error: 'This edit request has already been reviewed.' });

    if (input.action === 'approve') {
      const transaction = latest.transactions.find(item => item.id === editRequest.transactionId);
      if (!transaction) return send(res, 409, { error: 'The transaction no longer exists. Reject this request instead.' });
      if ((transaction.updatedAt || transaction.createdAt || null) !== editRequest.baseUpdatedAt) {
        return send(res, 409, { error: 'The transaction changed after this request was submitted. Reject this stale request.' });
      }
      Object.assign(transaction, editRequest.changes, { updatedAt: new Date().toISOString() });
      editRequest.status = 'Approved';
      recordTransactionHistory(latest, user, {
        transactionId: editRequest.transactionId,
        branch: transaction.branch,
        action: 'Edit approved',
        before: editRequest.original,
        after: editRequest.changes,
        requestedBy: editRequest.requesterName,
      });
    } else {
      editRequest.status = 'Rejected';
      recordTransactionHistory(latest, user, {
        transactionId: editRequest.transactionId,
        branch: editRequest.original.branch,
        action: 'Edit rejected',
        before: editRequest.original,
        after: editRequest.changes,
        requestedBy: editRequest.requesterName,
      });
    }
    editRequest.reviewedAt = new Date().toISOString();
    editRequest.reviewedBy = user.username;
    write(latest);
    return send(res, 200, { request: editRequest });
  }

  if (pathname === '/api/users' && method === 'GET') {
    const visibleUsers = isSuperAdmin(user)
      ? db.users
      : db.users.filter(account => account.role !== 'SuperAdmin');
    return send(res, 200, { users: visibleUsers.map(publicUser) });
  }

  if (pathname === '/api/users' && method === 'POST') {
    if (!isAdmin(user)) return send(res, 403, { error: 'Only Admins can create users.' });
    const input = await readJson(req);
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    if (!validUsername(username)) return send(res, 400, { error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.' });
    if (typeof input.password !== 'string' || input.password.length < PASSWORD_MIN_LENGTH) {
      return send(res, 400, { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
    }
    if (input.password.length > 128) return send(res, 400, { error: 'Password must be 128 characters or fewer.' });
    if (!ROLES.has(input.role)) return send(res, 400, { error: 'Choose a valid role.' });
    if (input.role === 'SuperAdmin' && !isSuperAdmin(user)) return send(res, 403, { error: 'Only SuperAdmins can create SuperAdmin accounts.' });
    if (db.users.some(account => account.username === username)) return send(res, 409, { error: 'That username already exists.' });
    const branch = input.role === 'Branch Manager' ? input.branch : null;
    if (input.role === 'Branch Manager' && !db.branches.includes(branch)) return send(res, 400, { error: 'Choose an active branch for this Branch Manager.' });
    const account = {
      id: crypto.randomUUID(),
      username,
      role: input.role,
      branch,
      passwordHash: await makePasswordHash(input.password),
    };
    const latest = read();
    if (latest.users.some(existing => existing.username === username)) return send(res, 409, { error: 'That username already exists.' });
    if (input.role === 'Branch Manager' && !latest.branches.includes(branch)) return send(res, 400, { error: 'Choose an active branch for this Branch Manager.' });
    latest.users.push(account);
    write(latest);
    return send(res, 201, { user: publicUser(account) });
  }

  if (pathname.startsWith('/api/users/') && method === 'DELETE') {
    if (!isAdmin(user)) return send(res, 403, { error: 'Only Admins can delete users.' });
    const id = decodeURIComponent(pathname.slice('/api/users/'.length));
    const account = db.users.find(existing => existing.id === id);
    if (!account) return send(res, 404, { error: 'User not found.' });
    if (account.role === 'SuperAdmin' || account.role === 'Admin' && !isSuperAdmin(user)) {
      return send(res, 403, { error: 'You cannot delete this account.' });
    }
    db.users = db.users.filter(existing => existing.id !== id);
    for (const [token, session] of sessions) {
      if (session.userId === id) sessions.delete(token);
    }
    write(db);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/transactions/backup' && method === 'GET') {
    if (!isAdmin(user)) return send(res, 403, { error: 'Only Admins can back up transaction data.' });
    const exportedAt = new Date().toISOString();
    return send(res, 200, { exportedAt, transactions: db.transactions }, {
      'Content-Disposition': `attachment; filename="KDCashflow-transactions-${exportedAt.slice(0, 10)}.json"`,
    });
  }

  if (pathname === '/api/transactions' && method === 'DELETE') {
    if (!isSuperAdmin(user)) return send(res, 403, { error: 'Only SuperAdmins can reset transaction data.' });
    const latest = read();
    const deletedCount = latest.transactions.length;
    for (const editRequest of latest.transactionEditRequests.filter(request => request.status === 'Pending')) {
      editRequest.status = 'Rejected';
      editRequest.reviewedAt = new Date().toISOString();
      editRequest.reviewedBy = user.username;
    }
    const historyDeletedCount = latest.transactionHistory.length;
    latest.transactions = [];
    latest.transactionHistory = [];
    write(latest);
    return send(res, 200, { ok: true, deletedCount, historyDeletedCount });
  }

  if (pathname === '/api/transactions' && method === 'POST') {
    if (!canCreateTransactions(user)) return send(res, 403, { error: 'You do not have permission to add transactions.' });
    const input = await readJson(req);
    const branch = user.role === 'Branch Manager' ? user.branch : input.branch;
    if (!['in', 'out'].includes(input.type) || typeof branch !== 'string' || !db.branches.includes(branch)
        || typeof input.category !== 'string' || !input.category.trim()
        || !Number.isFinite(Number(input.amount)) || !(Number(input.amount) > 0) || !validDate(input.date)) {
      return send(res, 400, { error: 'Please complete all required fields and enter a valid amount and date.' });
    }
    const latest = read();
    if (!latest.branches.includes(branch)) return send(res, 400, { error: 'Choose an active branch.' });
    const transaction = {
      id: crypto.randomUUID(),
      type: input.type,
      branch,
      category: input.category.trim(),
      amount: Number(input.amount),
      date: input.date,
      reference: String(input.reference || '').slice(0, 200),
      notes: String(input.notes || '').slice(0, 1000),
      createdAt: new Date().toISOString(),
    };
    latest.transactions.unshift(transaction);
    recordTransactionHistory(latest, user, {
      transactionId: transaction.id,
      branch: transaction.branch,
      action: 'Created',
      after: transaction,
    });
    write(latest);
    return send(res, 201, transaction);
  }

  if (pathname.startsWith('/api/transactions/') && method === 'DELETE') {
    if (!isSuperAdmin(user)) return send(res, 403, { error: 'Only SuperAdmins can delete transactions.' });
    const id = decodeURIComponent(pathname.slice('/api/transactions/'.length));
    const index = db.transactions.findIndex(transaction => transaction.id === id);
    if (index < 0) return send(res, 404, { error: 'Transaction not found.' });
    const [transaction] = db.transactions.splice(index, 1);
    recordTransactionHistory(db, user, {
      transactionId: transaction.id,
      branch: transaction.branch,
      action: 'Deleted',
      before: transaction,
    });
    for (const editRequest of db.transactionEditRequests.filter(request => request.transactionId === id && request.status === 'Pending')) {
      editRequest.status = 'Rejected';
      editRequest.reviewedAt = new Date().toISOString();
      editRequest.reviewedBy = user.username;
      recordTransactionHistory(db, user, {
        transactionId: id,
        branch: transaction.branch,
        action: 'Edit request invalidated by transaction deletion',
        before: editRequest.original,
        after: editRequest.changes,
        requestedBy: editRequest.requesterName,
      });
    }
    write(db);
    return send(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/transactions/') && method === 'PATCH') {
    if (!canEditTransactions(user)) return send(res, 403, { error: 'You do not have permission to edit transactions.' });
    const id = decodeURIComponent(pathname.slice('/api/transactions/'.length));
    const index = db.transactions.findIndex(transaction => transaction.id === id);
    if (index < 0) return send(res, 404, { error: 'Transaction not found.' });
    const input = await readJson(req);
    const existing = db.transactions[index];
    if (user.role === 'Branch Manager' && (existing.branch !== user.branch || input.branch !== user.branch)) {
      return send(res, 403, { error: 'You can only edit transactions for your assigned branch.' });
    }
    if (!['in', 'out'].includes(input.type) || typeof input.branch !== 'string'
        || (!db.branches.includes(input.branch) && input.branch !== existing.branch)
        || typeof input.category !== 'string' || !input.category.trim()
        || !Number.isFinite(Number(input.amount)) || !(Number(input.amount) > 0) || !validDate(input.date)) {
      return send(res, 400, { error: 'Please complete all required fields and enter a valid amount and date.' });
    }
    const changes = {
      type: input.type,
      branch: input.branch,
      date: input.date,
      category: input.category.trim(),
      amount: Number(input.amount),
      reference: String(input.reference || '').slice(0, 200),
      notes: String(input.notes || '').slice(0, 1000),
    };
    if (!isAdmin(user)) {
      const latest = read();
      const current = latest.transactions.find(transaction => transaction.id === id);
      if (!current) return send(res, 404, { error: 'Transaction not found.' });
      if (user.role === 'Branch Manager' && current.branch !== user.branch) {
        return send(res, 403, { error: 'You can only edit transactions for your assigned branch.' });
      }
      if (latest.transactionEditRequests.some(request => request.transactionId === id && request.status === 'Pending')) {
        return send(res, 409, { error: 'This transaction already has a pending edit request.' });
      }
      const editRequest = {
        id: crypto.randomUUID(),
        transactionId: id,
        requestedBy: user.id,
        requesterName: user.username,
        status: 'Pending',
        baseUpdatedAt: current.updatedAt || current.createdAt || null,
        original: Object.fromEntries(Object.keys(changes).map(key => [key, current[key] ?? ''])),
        changes,
        requestedAt: new Date().toISOString(),
      };
      latest.transactionEditRequests.push(editRequest);
      recordTransactionHistory(latest, user, {
        transactionId: id,
        branch: current.branch,
        action: 'Edit requested',
        before: editRequest.original,
        after: changes,
        requestId: editRequest.id,
      });
      write(latest);
      return send(res, 202, { request: editRequest });
    }
    db.transactions[index] = { ...existing, ...changes, updatedAt: new Date().toISOString() };
    recordTransactionHistory(db, user, {
      transactionId: id,
      branch: db.transactions[index].branch,
      action: 'Edited',
      before: existing,
      after: db.transactions[index],
    });
    write(db);
    return send(res, 200, db.transactions[index]);
  }

  if (pathname === '/api/branches' && method === 'POST') {
    if (!isAdmin(user) && user.role !== 'Accountant') return send(res, 403, { error: 'Only Admins and Accountants can add branches.' });
    const input = await readJson(req);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) return send(res, 400, { error: 'Branch name must be between 1 and 80 characters.' });
    const latest = read();
    if (latest.branches.some(branch => branch.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'That branch already exists.' });
    latest.branches.push(name);
    write(latest);
    return send(res, 201, { branches: latest.branches });
  }

  if (pathname === '/api/branches' && method === 'DELETE') {
    if (!isAdmin(user)) return send(res, 403, { error: 'Only Admins can remove branches.' });
    const name = url.searchParams.get('name');
    if (!name) return send(res, 400, { error: 'Branch name is required.' });
    if (!db.branches.includes(name)) return send(res, 404, { error: 'Branch not found.' });
    db.branches = db.branches.filter(branch => branch !== name);
    write(db);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found.' });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  if (req.socket.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end('Method not allowed');
    }
    return sendStatic(req, res);
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'The request could not be completed.' });
    else res.destroy();
    if (!error.status) console.error('Request failed:', error);
  }
});

server.listen(PORT, HOST, () => console.log(`KDCashflow running at http://localhost:${PORT}`));
