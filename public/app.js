'use strict';

let db = { branches: [], transactions: [] };
let currentUser = null;
let editingTransactionId = null;
const $ = id => document.getElementById(id);
const peso = value => '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const sum = (items, type) => items.filter(item => !type || item.type === type).reduce((total, item) => total + item.amount, 0);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const isAdmin = () => currentUser?.role === 'Admin';
const canCreateTransactions = () => isAdmin() || currentUser?.role === 'Accountant' || currentUser?.role === 'Branch Manager';

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2600);
}

function showAuth(setupRequired) {
  document.querySelector('.sidebar').classList.add('hidden');
  document.querySelector('.main').classList.add('hidden');
  let shell = $('authShell');
  if (!shell) {
    shell = document.createElement('section');
    shell.id = 'authShell';
    shell.className = 'auth-shell';
    document.body.prepend(shell);
  }
  shell.innerHTML = setupRequired
    ? `<form id="setupForm" class="auth-card"><div class="brandmark">KD</div><div class="eyebrow">SECURE ACCOUNT SETUP</div><h1>Create administrator</h1><p>Create the first Admin account to secure this cash monitoring system.</p><label>Username<input name="username" autocomplete="username" minlength="3" maxlength="32" required></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="12" required><small>Use at least 12 characters.</small></label><label>Confirm password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></label><button class="primary" type="submit">Create Admin account</button><div class="auth-error" id="authError"></div></form>`
    : `<form id="loginForm" class="auth-card"><div class="brandmark">KD</div><div class="eyebrow">KREME DONUTS · FINANCE</div><h1>Sign in</h1><p>Sign in to access cash monitoring.</p><label>Username<input name="username" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">Sign in</button><div class="auth-error" id="authError"></div></form>`;
  const form = $(setupRequired ? 'setupForm' : 'loginForm');
  form.onsubmit = async event => {
    event.preventDefault();
    const formData = new FormData(form);
    const password = formData.get('password');
    if (setupRequired && password !== formData.get('confirmPassword')) {
      $('authError').textContent = 'Passwords do not match.';
      return;
    }
    try {
      const session = await api(setupRequired ? '/api/setup' : '/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: formData.get('username'), password }),
      });
      await enterApp(session.user);
    } catch (error) {
      $('authError').textContent = error.message;
    }
  };
}

async function enterApp(user) {
  currentUser = user;
  $('authShell')?.remove();
  document.querySelector('.sidebar').classList.remove('hidden');
  document.querySelector('.main').classList.remove('hidden');
  configureRoleUi();
  await load();
}

function configureRoleUi() {
  const userLabel = document.querySelector('.sidebottom b');
  const roleLabel = document.querySelector('.sidebottom small');
  userLabel.textContent = currentUser.username;
  roleLabel.textContent = currentUser.role + (currentUser.branch ? ` · ${currentUser.branch}` : '');
  const footer = document.querySelector('.sidebottom');
  let logout = $('logoutButton');
  if (!logout) {
    logout = document.createElement('button');
    logout.id = 'logoutButton';
    logout.className = 'outline logout-button';
    logout.textContent = 'Sign out';
    footer.append(logout);
  }
  logout.onclick = async () => {
    try {
      await api('/api/logout', { method: 'POST', body: '{}' });
      currentUser = null;
      location.reload();
    } catch (error) {
      toast(error.message);
    }
  };
  $('quickAdd').classList.toggle('hidden', !canCreateTransactions());
  $('addBranch').classList.toggle('hidden', !isAdmin());

  if (isAdmin() && !$('usersPage')) {
    const navigation = document.querySelector('.sidebottom');
    const userNav = document.createElement('button');
    userNav.className = 'nav';
    userNav.dataset.page = 'users';
    userNav.innerHTML = '♙ <span>Users</span>';
    navigation.before(userNav);
    const page = document.createElement('section');
    page.id = 'usersPage';
    page.className = 'page hidden';
    page.innerHTML = `<div class="toolbar"><div><h2>User management</h2><p>Create accounts and assign access roles.</p></div></div><section class="panel user-panel"><h3>Create user</h3><form id="userForm"><div class="formgrid"><label>Username *<input name="username" minlength="3" maxlength="32" required></label><label>Temporary password *<input name="password" type="password" minlength="12" autocomplete="new-password" required><small>At least 12 characters.</small></label><label>Role *<select name="role" required><option>Accountant</option><option>Branch Manager</option><option>Admin</option></select></label><label id="userBranchField" class="hidden">Assigned branch *<select name="branch"></select></label></div><button class="primary" type="submit">Create user</button></form></section><section class="panel user-panel"><h3>Existing users</h3><div id="userList" class="user-list"></div></section><section class="panel user-panel"><h3>Transaction data</h3><p class="data-tools-note">Backup includes transaction records only. Reset removes all transactions but preserves user accounts and branches.</p><div class="data-tools"><button class="outline" id="backupTransactions">↓ Download transaction backup</button><button class="danger-button" id="resetTransactions">Reset all transactions</button></div></section>`;
    document.querySelector('.main').append(page);
    document.addEventListener('click', event => {
      const target = event.target.closest('.nav');
      if (target?.dataset.page) pageTo(target.dataset.page);
    });
    $('userForm').elements.role.onchange = () => {
      $('userBranchField').classList.toggle('hidden', $('userForm').elements.role.value !== 'Branch Manager');
    };
    $('userForm').onsubmit = createUser;
  }
  document.querySelectorAll('.nav').forEach(button => {
    if (button.dataset.page !== 'users') button.onclick = () => pageTo(button.dataset.page);
  });
  document.querySelectorAll('[data-goto]').forEach(button => {
    button.onclick = () => pageTo(button.dataset.goto);
  });
}

function pageTo(name) {
  if (name === 'users' && !isAdmin()) return;
  document.querySelectorAll('.page').forEach(page => page.classList.add('hidden'));
  $(name + 'Page')?.classList.remove('hidden');
  $('quickAdd').classList.toggle('hidden', name !== 'dashboard' || !canCreateTransactions());
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.page === name));
  $('pageTitle').textContent = name === 'users' ? 'Users' : name[0].toUpperCase() + name.slice(1);
}

async function createUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify(values) });
    form.reset();
    $('userBranchField').classList.add('hidden');
    await loadUsers();
    toast('User created.');
  } catch (error) {
    toast(error.message);
  }
}

async function loadUsers() {
  if (!isAdmin()) return;
  const result = await api('/api/users');
  $('userList').innerHTML = result.users.length
    ? result.users.map(user => `<div class="user-row"><strong>${escapeHtml(user.username)}</strong><span>${escapeHtml(user.role)}</span><small>${escapeHtml(user.branch || 'All branches')}</small>${user.role !== 'Admin' ? `<button class="deletebtn user-remove" data-remove-user="${escapeHtml(user.id)}" aria-label="Delete ${escapeHtml(user.role)} ${escapeHtml(user.username)}">Delete user</button>` : ''}</div>`).join('')
    : '<div class="empty">No user accounts found.</div>';
}

async function handleAdminActions(event) {
  const removeUser = event.target.closest('[data-remove-user]');
  if (removeUser) {
    if (!isAdmin() || !confirm('Delete this Accountant or Branch Manager account? The user will be signed out immediately.')) return;
    try {
      await api('/api/users/' + encodeURIComponent(removeUser.dataset.removeUser), { method: 'DELETE' });
      await loadUsers();
      toast('User deleted.');
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  if (event.target.closest('#backupTransactions')) {
    if (!isAdmin()) return;
    try {
      const backup = await api('/api/transactions/backup');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      link.download = `KDCashflow-transactions-${today()}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      toast(`Transaction backup downloaded (${backup.transactions.length} records).`);
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  if (event.target.closest('#resetTransactions')) {
    if (!isAdmin() || !confirm('This will permanently delete every transaction. User accounts and branches will be preserved. Continue?')) return;
    if (prompt('Type RESET to confirm deleting all transactions:') !== 'RESET') {
      toast('Transaction reset cancelled.');
      return;
    }
    try {
      const result = await api('/api/transactions', { method: 'DELETE' });
      await load();
      toast(`Transaction data reset. ${result.deletedCount} records deleted; users and branches were preserved.`);
    } catch (error) {
      toast(error.message);
    }
  }
}

async function load() {
  db = await api('/api/data');
  render();
  if (isAdmin()) {
    const branches = $('userForm').elements.branch;
    branches.innerHTML = db.branches.map(branch => `<option value="${escapeHtml(branch)}">${escapeHtml(branch)}</option>`).join('');
    await loadUsers();
  }
}

function options() {
  const opts = db.branches.map(branch => `<option value="${escapeHtml(branch)}">${escapeHtml(branch)}</option>`).join('');
  $('txBranch').innerHTML = opts;
  $('branchFilter').innerHTML = '<option value="all">All branches</option>' + opts;
  $('recBranch').innerHTML = opts;
}

function render() {
  options();
  const ins = sum(db.transactions, 'in');
  const outs = sum(db.transactions, 'out');
  $('totalIn').textContent = peso(ins);
  $('totalOut').textContent = peso(outs);
  $('netCash').textContent = peso(ins - outs);
  $('branchCount').textContent = db.branches.length;
  renderChart();
  renderBranchBalances();
  renderRecent();
  renderAll();
  renderBranchCards();
}

function renderChart() {
  const year = new Date().getFullYear();
  const months = Array.from({ length: 12 }, (_, index) => ({
    name: new Date(year, index, 1).toLocaleString('en', { month: 'short' }), in: 0, out: 0,
  }));
  db.transactions.forEach(transaction => {
    const date = new Date(transaction.date + 'T12:00:00');
    if (date.getFullYear() === year) months[date.getMonth()][transaction.type] += transaction.amount;
  });
  const max = Math.max(1, ...months.flatMap(month => [month.in, month.out]));
  $('chart').innerHTML = months.map(month => `<div class="month"><div class="bars"><div class="bar in" title="Cash in ${peso(month.in)}" style="height:${month.in / max * 100}%"></div><div class="bar out" title="Cash out ${peso(month.out)}" style="height:${month.out / max * 100}%"></div></div><small>${month.name}</small></div>`).join('');
}

function branchTotals(branch) {
  const transactions = db.transactions.filter(transaction => transaction.branch === branch);
  return { in: sum(transactions, 'in'), out: sum(transactions, 'out') };
}

function renderBranchBalances() {
  const values = db.branches.map(branch => ({ branch, ...branchTotals(branch) }));
  const max = Math.max(1, ...values.map(value => Math.max(value.in, value.out)));
  $('branchBalances').innerHTML = values.length
    ? values.slice(0, 6).map(value => `<div class="branchline"><b>${escapeHtml(value.branch)}</b><strong>${peso(value.in - value.out)}</strong><small>In ${peso(value.in)} · Out ${peso(value.out)}</small><div class="progress"><span style="width:${Math.max(2, Math.abs(value.in - value.out) / max * 100)}%"></span></div></div>`).join('')
    : '<div class="empty">No branches added.</div>';
}

function row(transaction, allowEdit = false) {
  return `<tr><td>${escapeHtml(transaction.date)}</td><td>${escapeHtml(transaction.branch)}</td><td><span class="pill ${transaction.type}">${transaction.type === 'in' ? 'CASH IN' : 'CASH OUT'}</span></td><td>${escapeHtml(transaction.category)}</td><td>${escapeHtml(transaction.reference || '—')}</td><td class="right amount" style="color:${transaction.type === 'in' ? '#16865a' : '#d71920'}">${transaction.type === 'in' ? '+' : '−'}${peso(transaction.amount)}</td>${allowEdit ? `<td><button class="outline editbtn" data-edit="${escapeHtml(transaction.id)}" title="Edit transaction">Edit</button><button class="deletebtn" data-delete="${escapeHtml(transaction.id)}" title="Delete transaction">✕</button></td>` : ''}</tr>`;
}

function renderRecent() {
  $('recentRows').innerHTML = db.transactions.length
    ? db.transactions.slice(0, 6).map(transaction => row(transaction)).join('')
    : '<tr><td colspan="6" class="empty">No transactions yet.</td></tr>';
}

function renderAll() {
  const query = $('search').value.toLowerCase();
  const type = $('typeFilter').value;
  const branch = $('branchFilter').value;
  const transactions = db.transactions.filter(transaction =>
    (type === 'all' || transaction.type === type)
    && (branch === 'all' || transaction.branch === branch)
    && [transaction.branch, transaction.category, transaction.reference, transaction.notes].join(' ').toLowerCase().includes(query));
  $('allRows').innerHTML = transactions.length
    ? transactions.map(transaction => row(transaction, isAdmin())).join('')
    : `<tr><td colspan="${isAdmin() ? 7 : 6}" class="empty">No matching transactions found.</td></tr>`;
  $('recordCount').textContent = `${transactions.length} record${transactions.length === 1 ? '' : 's'}`;
}

function renderBranchCards() {
  $('branchCards').innerHTML = db.branches.map(branch => {
    const totals = branchTotals(branch);
    const count = db.transactions.filter(transaction => transaction.branch === branch).length;
    return `<article class="branchcard"><h3>⌂ &nbsp;${escapeHtml(branch)}</h3><strong>${peso(totals.in - totals.out)}</strong><small>Net recorded cash</small><div class="split"><span>Cash in<br><b style="color:#16865a">${peso(totals.in)}</b></span><span>Cash out<br><b style="color:#d71920">${peso(totals.out)}</b></span><span>Entries<br><b>${count}</b></span></div>${isAdmin() ? `<button class="deletebtn branch-remove" data-remove-branch="${escapeHtml(branch)}" aria-label="Remove ${escapeHtml(branch)} branch">Remove branch</button>` : ''}</article>`;
  }).join('') || '<div class="empty">No branches added.</div>';
}

function openModal() {
  editingTransactionId = null;
  $('transactionForm').reset();
  document.querySelector('input[name=type]:checked').dispatchEvent(new Event('change'));
  document.querySelector('.modalhead h2').textContent = 'New transaction';
  $('transactionForm').querySelector('[type=submit]').textContent = 'Save transaction';
  $('txDate').value = today();
  $('transactionModal').classList.remove('hidden');
}

function editTransaction(id) {
  if (!isAdmin()) return;
  const transaction = db.transactions.find(item => item.id === id);
  if (!transaction) return;
  openModal();
  editingTransactionId = transaction.id;
  if (![...$('txBranch').options].some(option => option.value === transaction.branch)) {
    $('txBranch').add(new Option(transaction.branch, transaction.branch));
  }
  $('txBranch').value = transaction.branch;
  $('txDate').value = transaction.date;
  const typeRadio = document.querySelector(`input[name=type][value="${transaction.type}"]`);
  typeRadio.checked = true;
  typeRadio.dispatchEvent(new Event('change'));
  $('txCategory').value = transaction.category;
  $('txAmount').value = transaction.amount;
  $('txReference').value = transaction.reference || '';
  $('txNotes').value = transaction.notes || '';
  document.querySelector('.modalhead h2').textContent = 'Edit transaction';
  $('transactionForm').querySelector('[type=submit]').textContent = 'Save changes';
}
function closeModal() {
  $('transactionModal').classList.add('hidden');
}

async function saveTransaction(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = document.querySelector('input[name=type]:checked').value;
  try {
    await api(editingTransactionId ? '/api/transactions/' + encodeURIComponent(editingTransactionId) : '/api/transactions', {
      method: editingTransactionId ? 'PATCH' : 'POST',
      body: JSON.stringify({
        type,
        branch: $('txBranch').value,
        date: $('txDate').value,
        category: $('txCategory').value,
        amount: $('txAmount').value,
        reference: $('txReference').value,
        notes: $('txNotes').value,
      }),
    });
    form.reset();
    closeModal();
    await load();
    editingTransactionId = null;
    toast('Transaction saved successfully.');
  } catch (error) {
    toast(error.message);
  }
}

async function handleTableAction(event) {
  const editButton = event.target.closest('[data-edit]');
  if (editButton) {
    editTransaction(editButton.dataset.edit);
    return;
  }
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    if (!isAdmin() || !confirm('Delete this transaction? This cannot be undone.')) return;
    try {
      await api('/api/transactions/' + encodeURIComponent(deleteButton.dataset.delete), { method: 'DELETE' });
      await load();
      toast('Transaction deleted.');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const removeButton = event.target.closest('[data-remove-branch]');
  if (!removeButton || !isAdmin()
      || !confirm(`Remove "${removeButton.dataset.removeBranch}" from active branches? Its transaction history will be retained.`)) return;
  try {
    await api('/api/branches?name=' + encodeURIComponent(removeButton.dataset.removeBranch), { method: 'DELETE' });
    await load();
    toast('Branch removed. Its transaction history was retained.');
  } catch (error) {
    toast(error.message);
  }
}

function addBranch() {
  const name = prompt('Enter branch name:');
  if (!name?.trim()) return;
  api('/api/branches', { method: 'POST', body: JSON.stringify({ name }) })
    .then(async () => { await load(); toast('Branch added.'); })
    .catch(error => toast(error.message));
}

function downloadCsv(transactions, filename) {
  const rows = [
    ['Date', 'Branch', 'Type', 'Category', 'Amount', 'Reference', 'Notes'],
    ...transactions.map(transaction => [transaction.date, transaction.branch, transaction.type, transaction.category, transaction.amount, transaction.reference, transaction.notes]),
  ];
  const csv = rows.map(rowValues => rowValues.map(value => '"' + String(value ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportCsv() {
  downloadCsv(db.transactions, 'KDCashflow-transactions-' + today() + '.csv');
}

function getDateRecords() {
  const startDate = $('recordStartDate').value;
  const endDate = $('recordEndDate').value;
  if (!startDate || !endDate) {
    toast('Choose both a start date and an end date.');
    return null;
  }
  if (startDate > endDate) {
    toast('The start date must be on or before the end date.');
    return null;
  }
  const transactions = db.transactions.filter(transaction => transaction.date >= startDate && transaction.date <= endDate);
  if (!transactions.length) {
    toast('No transactions found for the selected date range.');
    return null;
  }
  return { startDate, endDate, transactions };
}

function downloadDateRecords() {
  const report = getDateRecords();
  if (!report) return;
  downloadCsv(report.transactions, `KDCashflow-transactions-${report.startDate}-to-${report.endDate}.csv`);
}

function printDateRecords() {
  const report = getDateRecords();
  if (!report) return;
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    toast('Allow pop-ups to print transaction records.');
    return;
  }
  const transactionRows = report.transactions.map(transaction =>
    `<tr><td>${escapeHtml(transaction.date)}</td><td>${escapeHtml(transaction.branch)}</td><td>${transaction.type === 'in' ? 'Cash in' : 'Cash out'}</td><td>${escapeHtml(transaction.category)}</td><td>${escapeHtml(transaction.reference || '')}</td><td class="amount">${peso(transaction.amount)}</td><td>${escapeHtml(transaction.notes || '')}</td></tr>`
  ).join('');
  const totalIn = sum(report.transactions, 'in');
  const totalOut = sum(report.transactions, 'out');
  printWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Transactions ${report.startDate} to ${report.endDate}</title><style>@page{margin:16mm}body{font:12px Arial,sans-serif;color:#171717}h1{font-size:20px;margin-bottom:4px}.summary{margin:16px 0}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:7px;text-align:left}th{background:#f2f2f2}.amount{text-align:right;white-space:nowrap}</style></head><body><h1>Transaction Records</h1><div>Date range: ${escapeHtml(report.startDate)} to ${escapeHtml(report.endDate)}</div><div class="summary">Records: ${report.transactions.length} &nbsp; | &nbsp; Cash in: ${peso(totalIn)} &nbsp; | &nbsp; Cash out: ${peso(totalOut)}</div><table><thead><tr><th>Date</th><th>Branch</th><th>Type</th><th>Category</th><th>Reference</th><th>Amount</th><th>Notes</th></tr></thead><tbody>${transactionRows}</tbody></table></body></html>`);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => printWindow.print(), 250);
}

function calculateReconciliation() {
  const branch = $('recBranch').value;
  const date = $('recDate').value;
  const opening = Number($('opening').value || 0);
  const physical = Number($('physical').value || 0);
  const transactions = db.transactions.filter(transaction => transaction.branch === branch && transaction.date === date);
  const ins = sum(transactions, 'in');
  const outs = sum(transactions, 'out');
  const expected = opening + ins - outs;
  const difference = physical - expected;
  $('recResult').classList.remove('hidden');
  $('recResult').innerHTML = `<h3>${difference === 0 ? 'Cash balanced' : difference > 0 ? 'Cash over' : 'Cash short'}</h3><div class="formgrid"><div>Opening cash<br><b>${peso(opening)}</b></div><div>Cash in<br><b style="color:#16865a">${peso(ins)}</b></div><div>Cash out<br><b style="color:#d71920">${peso(outs)}</b></div><div>Expected cash<br><b>${peso(expected)}</b></div><div>Physical count<br><b>${peso(physical)}</b></div><div>Difference<br><strong style="color:${difference === 0 || difference > 0 ? '#16865a' : '#d71920'}">${difference > 0 ? '+' : ''}${peso(difference)}</strong></div></div>`;
}

document.querySelectorAll('input[name=type]').forEach(radio => {
  radio.onchange = () => {
    const categories = radio.value === 'in'
      ? ['Sales collection', 'Cash deposit', 'Capital contribution', 'Other income', 'Other']
      : ['Supplies', 'Payroll', 'Utilities', 'Rent', 'Delivery / transport', 'Bank withdrawal', 'Other expense'];
    $('txCategory').innerHTML = categories.map(category => `<option>${category}</option>`).join('');
  };
});

$('quickAdd').onclick = openModal;
$('addTransaction').onclick = openModal;
['closeModal', 'cancelModal'].forEach(id => $(id).onclick = closeModal);
$('transactionForm').onsubmit = saveTransaction;
$('addBranch').onclick = addBranch;
$('exportCsv').onclick = exportCsv;
$('recordStartDate').value = today();
$('recordEndDate').value = today();
$('downloadDateRecords').onclick = downloadDateRecords;
$('printDateRecords').onclick = printDateRecords;
$('recDate').value = today();
$('calculate').onclick = calculateReconciliation;
['search', 'typeFilter', 'branchFilter'].forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', renderAll));
document.addEventListener('click', handleTableAction);
document.addEventListener('click', handleAdminActions);
$('txCategory').innerHTML = ['Sales collection', 'Cash deposit', 'Capital contribution', 'Other income', 'Other'].map(category => `<option>${category}</option>`).join('');

async function start() {
  try {
    const { setupRequired } = await api('/api/setup-status');
    if (setupRequired) return showAuth(true);
    try {
      const session = await api('/api/session');
      await enterApp(session.user);
    } catch (error) {
      if (error.message !== 'Please sign in to continue.') throw error;
      showAuth(false);
    }
  } catch (error) {
    showAuth(false);
    const message = $('authError');
    if (message) message.textContent = 'Cannot connect to the local server. Please restart KDCashflow.';
  }
}

start();
