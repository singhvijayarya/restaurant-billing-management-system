const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'restaurant-test-'));
const databasePath = path.join(directory, 'test.sqlite');
let port;
let child;
let base;
let menu;
let orderId;
const appPath = path.resolve(__dirname, '..');

async function request(route, method = 'GET', body, headers = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function rawRequest(route, body) {
  const response = await fetch(`${base}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function startServer() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: appPath,
    env: { ...process.env, PORT: String(port), DB_PATH: databasePath, TAX_RATE_BPS: '825' },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start within eight seconds.');
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

async function createTestOrder(body, key = randomUUID()) {
  return request('/orders', 'POST', body, { 'Idempotency-Key': key });
}

before(async () => {
  port = await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const availablePort = socket.address().port;
      socket.close(() => resolve(availablePort));
    });
  });
  base = `http://127.0.0.1:${port}`;
  await startServer();
  assert.deepEqual((await request('/health')).body, { status: 'ok' });
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Restaurant Desk/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
});

after(async () => {
  await stopServer();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('empty database dashboard and menu validation, creation, update, search, and filters', async () => {
  const initial = (await request('/dashboard')).body;
  assert.equal(initial.total_orders, 0);
  assert.equal(initial.completed_today, 0);
  assert.equal(initial.sales_today_paise, 0);
  assert.equal(initial.pending_orders, 0);
  assert.equal((await request('/menu?available=maybe')).status, 400);
  assert.equal((await request('/menu', 'POST', null)).status, 400);
  assert.equal((await rawRequest('/menu', '{')).status, 400);
  assert.equal((await request('/menu', 'POST', { name: '', category: 'Main', price: 5 })).status, 400);
  assert.equal((await request('/menu', 'POST', { name: 'Bad', category: 'Main', price: -1 })).status, 400);

  const decimal = await request('/menu', 'POST', {
    name: 'Decimal Test', category: 'Test', price: 0.29, available: true,
  });
  assert.equal(decimal.status, 201);
  assert.equal(decimal.body.price_paise, 29);

  const created = await request('/menu', 'POST', {
    name: 'Test Curry', description: 'Fixture', category: 'Main course', price: 100.25, available: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.price_paise, 10025);
  menu = created.body;

  const updated = await request(`/menu/${menu.id}`, 'PUT', {
    name: 'Test Curry', description: 'Changed', category: 'Main course', price: 120, available: true,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.price_paise, 12000);
  assert.equal((await request('/menu?q=Curry')).body[0].id, menu.id);
  assert.equal((await request('/menu?available=0')).body.length, 0);
  assert.equal((await request(`/menu/${'9'.repeat(40)}`, 'PUT', {})).status, 400);
});

test('order and item inserts roll back together after a database failure', async () => {
  const fixture = new DatabaseSync(databasePath);
  fixture.exec(`
    CREATE TRIGGER fail_order_item_insert
    BEFORE INSERT ON order_items
    BEGIN SELECT RAISE(ABORT, 'simulated item insert failure'); END;
  `);
  try {
    const failed = await createTestOrder({
      order_type: 'Takeaway', items: [{ menu_item_id: menu.id, quantity: 1 }],
    });
    assert.equal(failed.status, 500);
    assert.equal(failed.body.error, 'An unexpected server error occurred.');
    assert.equal((await request('/orders')).body.length, 0);
  } finally {
    fixture.exec('DROP TRIGGER fail_order_item_insert');
    fixture.close();
  }
});

test('order validation, authoritative prices, multi-item totals, tax rounding, and idempotency', async () => {
  assert.equal((await createTestOrder({ items: [] })).status, 400);
  assert.equal((await request('/orders', 'POST', { items: [] })).status, 400);
  assert.equal((await createTestOrder({ items: null })).status, 400);
  assert.equal((await request('/orders', 'POST', { items: [{ menu_item_id: menu.id, quantity: 1 }] })).status, 400);
  assert.equal((await createTestOrder({ items: [{ menu_item_id: menu.id, quantity: 0 }] })).status, 400);
  assert.equal((await createTestOrder({ items: [{ menu_item_id: menu.id, quantity: 100 }] })).status, 400);
  assert.equal((await createTestOrder({ items: [{ menu_item_id: menu.id, quantity: 1 }, { menu_item_id: menu.id, quantity: 1 }] })).status, 400);
  assert.equal((await createTestOrder({ order_type: 'Takeaway', items: [{ menu_item_id: 999999, quantity: 1 }] })).status, 404);

  const unavailable = await request('/menu', 'POST', {
    name: 'Sold Out', category: 'Main', price: 1, available: false,
  });
  assert.equal((await createTestOrder({ items: [{ menu_item_id: unavailable.body.id, quantity: 1 }] })).status, 400);

  const decimalItem = (await request('/menu?q=Decimal Test')).body[0];
  const key = randomUUID();
  const orderBody = {
    order_type: 'Dine in', table_number: '8', customer_name: 'Asha',
    items: [
      { menu_item_id: menu.id, quantity: 2, price: 1 },
      { menu_item_id: decimalItem.id, quantity: 1 },
    ],
  };
  const created = await createTestOrder(orderBody, key);
  assert.equal(created.status, 201);
  assert.equal(created.body.subtotal_paise, 24029);
  assert.equal(created.body.tax_paise, 1982);
  assert.equal(created.body.total_paise, 26011);
  assert.deepEqual(created.body.items.map(item => item.unit_price_paise), [12000, 29]);
  orderId = created.body.id;

  const retry = await createTestOrder(orderBody, key);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, orderId);
  assert.equal((await request('/orders')).body.length, 1);
  assert.equal((await request(`/orders?q=${orderId}`)).body.length, 1);
  const keyConflict = await createTestOrder({ ...orderBody, customer_name: 'Different request' }, key);
  assert.equal(keyConflict.status, 409);

  const twoRupeeItem = await request('/menu', 'POST', {
    name: 'Tax Rounding Test', category: 'Test', price: 2, available: true,
  });
  const rounded = await createTestOrder({ order_type: 'Takeaway', items: [{ menu_item_id: twoRupeeItem.body.id, quantity: 1 }] });
  assert.equal(rounded.body.subtotal_paise, 200);
  assert.equal(rounded.body.tax_paise, 17);
  assert.equal(rounded.body.total_paise, 217);

  const free = await request('/menu', 'POST', { name: 'Complimentary tea', category: 'Drinks', price: 0 });
  const freeOrder = await createTestOrder({ order_type: 'Takeaway', items: [{ menu_item_id: free.body.id, quantity: 99 }] });
  assert.equal(freeOrder.status, 201);
  assert.equal(freeOrder.body.subtotal_paise, 0);
  assert.equal(freeOrder.body.total_paise, 0);

  const changedItem = await request(`/menu/${menu.id}`, 'PUT', {
    name: 'Curry renamed', description: 'Changed later', category: 'Main course', price: 175, available: true,
  });
  assert.equal(changedItem.body.price_paise, 17500);
  const attemptToOverridePrice = await createTestOrder({
    order_type: 'Takeaway', items: [{ menu_item_id: menu.id, quantity: 1, price: 0.01 }],
  });
  assert.equal(attemptToOverridePrice.body.items[0].unit_price_paise, 17500);
});

test('order survives restart; historical bill, status, payment, and statistics stay consistent', async () => {
  await stopServer();
  const init = spawnSync(process.execPath, ['scripts/init-db.js'], {
    cwd: appPath,
    env: { ...process.env, DB_PATH: databasePath, TAX_RATE_BPS: '825' },
    encoding: 'utf8',
  });
  assert.equal(init.status, 0, init.stderr);
  await startServer();
  const retrieved = await request(`/orders/${orderId}`);
  assert.equal(retrieved.status, 200, JSON.stringify(retrieved.body));
  assert.equal(retrieved.body.items[0].name, 'Test Curry');
  assert.equal(retrieved.body.items[0].unit_price_paise, 12000);
  assert.equal(retrieved.body.total_paise, 26011);
  assert.equal((await request(`/orders/${'9'.repeat(40)}`)).status, 400);
  assert.equal((await request(`/orders/${orderId + 9999}`)).status, 404);

  assert.equal((await request(`/orders/${orderId}/status`, 'PATCH', null)).status, 400);
  assert.equal((await request(`/orders/${orderId}/status`, 'PATCH', { status: 'Ready' })).status, 400);
  assert.equal((await request(`/orders/${orderId}/status`, 'PATCH', { status: 'Preparing' })).status, 200);
  assert.equal((await request(`/orders/${orderId}/payment`, 'POST', { method: 'Bitcoin' })).status, 400);
  const paid = await request(`/orders/${orderId}/payment`, 'POST', { method: 'UPI' });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.payment_status, 'Paid');
  assert.equal(paid.body.payment.method, 'UPI');
  assert.equal((await request(`/orders/${orderId}/payment`, 'POST', { method: 'UPI' })).status, 409);
  assert.equal((await request(`/orders/${orderId}/status`, 'PATCH', { status: 'Ready' })).status, 200);
  assert.equal((await request(`/orders/${orderId}/status`, 'PATCH', { status: 'Completed' })).status, 200);
  assert.equal((await request(`/orders/${orderId}/status`, 'PATCH', { status: 'Preparing' })).status, 400);

  const dashboard = (await request('/dashboard')).body;
  assert.equal(dashboard.total_orders, 4);
  assert.equal(dashboard.completed_today, 1);
  assert.equal(dashboard.pending_orders, 3);
  assert.equal(dashboard.sales_today_paise, 26011);
});
