import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(() => {
  try {
    execSync('docker exec societyos-prod-redis-1 redis-cli flushall', { stdio: 'ignore' });
  } catch {}
});

const RESIDENT = { email: 'resident.a1@societyos.dev', password: 'Society#2026' };
const ADMIN = { email: 'admin.a@societyos.dev', password: 'AdminA#2026' };

async function login(page: Page, credentials: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.fill('#email', credentials.email);
  await page.fill('#password', credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function logout(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: 'Sign out' });
  if (await btn.isVisible()) {
    await btn.click();
  } else {
    await page.request.post('/api/v1/auth/logout');
    await page.goto('/login');
  }
  await expect(page).toHaveURL(/\/login$/);
}

test('society operations lifecycle: notice board circulars, maintenance tickets, and amenity booking', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // 1. Admin logs in and publishes an official circular
  await login(page, ADMIN);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Command view' })).toBeVisible();

  // Navigate to Circulars tab
  await page.getByRole('button', { name: 'Circulars' }).click();
  await expect(page.getByText('Society Circulars & Announcements')).toBeVisible();

  const noticeTitle = `Water Tank Cleaning & Outage ${Date.now()}`;
  await page.getByRole('button', { name: 'Post Announcement' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Publish New Announcement' })).toBeVisible();

  await page.fill('#ann-title', noticeTitle);
  await page.selectOption('#ann-cat', 'MAINTENANCE');
  await page.fill('#ann-content', 'Scheduled overhead tank cleaning tomorrow between 10:00 AM and 2:00 PM.');
  await page.check('#ann-pinned');
  await page.getByRole('button', { name: 'Publish Notice' }).click();

  // Verify notice appears in admin list
  await expect(page.getByText(noticeTitle)).toBeVisible();

  await logout(page);

  // 2. Resident logs in and views the notice on the community board
  await login(page, RESIDENT);
  await expect(page).toHaveURL(/\/resident$/);

  // Go to Notice board tab
  await page.getByRole('button', { name: 'Notice board' }).click();
  await expect(page.getByText('Community Notice Board')).toBeVisible();
  await expect(page.getByText(noticeTitle)).toBeVisible();

  // 3. Resident raises a maintenance request
  await page.getByRole('button', { name: 'Maintenance' }).click();
  await expect(page.getByText('Maintenance & Helpdesk')).toBeVisible();

  const ticketTitle = `Kitchen Plumbing Leak ${Date.now()}`;
  await page.getByRole('button', { name: 'Raise Ticket' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Raise Maintenance Ticket' })).toBeVisible();

  await page.selectOption('#ticket-category', 'PLUMBING');
  await page.selectOption('#ticket-priority', 'HIGH');
  await page.fill('#ticket-title', ticketTitle);
  await page.fill('#ticket-desc', 'Severe drip under the main kitchen sink.');
  await page.getByRole('button', { name: 'Submit Ticket' }).click();

  // Verify ticket appears in resident queue
  await expect(page.getByText(ticketTitle)).toBeVisible();
  await expect(page.getByText(/HIGH/i).first()).toBeVisible();

  // 4. Resident reserves an amenity (e.g. Tennis Court or Badminton)
  await page.getByRole('button', { name: 'Amenities' }).click();
  await expect(page.getByText('Amenity Reservations')).toBeVisible();

  // Click on the first "Book Slot" button
  const bookBtn = page.getByRole('button', { name: 'Book Slot' }).first();
  await bookBtn.waitFor({ state: 'visible' });
  await bookBtn.click();
  await expect(page.getByRole('dialog', { name: /Book/ })).toBeVisible();

  // Pick unique future date and random hour to avoid slot collision across test runs
  const randomDay = Math.floor(Math.random() * 500) + 30;
  const uniqueDate = new Date(Date.now() + 86400000 * randomDay).toISOString().split('T')[0];
  const hour = String(Math.floor(Math.random() * 8) + 10).padStart(2, '0');
  const endHour = String(Number(hour) + 1).padStart(2, '0');
  await page.fill('#book-date', uniqueDate);
  await page.fill('#book-start', `${hour}:00`);
  await page.fill('#book-end', `${endHour}:00`);
  await page.fill('#book-guests', '4');
  await page.getByRole('button', { name: 'Confirm Reservation' }).click();

  // Ensure modal has closed
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Verify active reservation appears
  await expect(page.getByText('CONFIRMED').first()).toBeVisible();

  await logout(page);

  // 5. Admin logs back in to update the maintenance ticket
  await login(page, ADMIN);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Command view' })).toBeVisible();
  await page.getByRole('button', { name: 'Helpdesk' }).click();
  await expect(page.getByText('Community Facility Helpdesk')).toBeVisible();
  await expect(page.getByText(ticketTitle)).toBeVisible();

  // Find the row with the ticket and click Update
  const ticketRow = page.locator('tr', { hasText: ticketTitle });
  await ticketRow.getByRole('button', { name: 'Update' }).click();
  await expect(page.getByRole('dialog', { name: /Update Ticket/ })).toBeVisible();

  await page.selectOption('#ticket-status-select', 'RESOLVED');
  await page.fill('#ticket-staff-input', 'Suresh Technician');
  await page.getByRole('button', { name: 'Save Changes' }).click();

  // Verify resolved status in table
  await expect(ticketRow.getByText('RESOLVED')).toBeVisible();
  await expect(ticketRow.getByText('Suresh Technician')).toBeVisible();

  // 6. Verify Admin Amenities tab
  await page.getByRole('button', { name: 'Amenities' }).click();
  await expect(page.getByText('Community Facility Bookings')).toBeVisible();
  await expect(page.getByText('CONFIRMED').first()).toBeVisible();

  // 7. Admin Maintenance Billing & Invoicing
  await page.getByRole('button', { name: 'Maintenance billing' }).click();
  await expect(page.getByText('Society Maintenance Billing & Ledger')).toBeVisible();

  const invoiceTitle = `Standard Society Dues ${Date.now()}`;
  await page.getByRole('button', { name: 'Generate Invoice' }).click();
  await expect(page.getByRole('dialog', { name: 'Generate Maintenance Invoice' })).toBeVisible();

  // Select flat, title, amount, dueDate
  const flatSelect = page.locator('select').first();
  if (await flatSelect.isVisible()) {
    await flatSelect.selectOption({ index: 1 });
  }
  await page.fill('input[placeholder*="Monthly Maintenance"]', invoiceTitle);
  await page.fill('input[type="number"]', '5200');
  await page.fill('input[type="date"]', '2026-11-25');
  await page.getByRole('button', { name: 'Issue Invoice' }).click();

  // Verify invoice appears in table
  await expect(page.getByText(invoiceTitle)).toBeVisible();
  await expect(page.getByText('₹5,200').first()).toBeVisible();

  await logout(page);

  // 8. Resident logs in and settles the invoice
  await login(page, RESIDENT);
  await expect(page).toHaveURL(/\/resident$/);

  await page.getByRole('button', { name: 'Dues & Bills' }).click();
  await expect(page.getByText('Maintenance & Society Dues')).toBeVisible();

  // Find any unsettled invoice or our newly generated invoice
  const settleBtn = page.getByRole('button', { name: 'Settle Bill' }).first();
  if (await settleBtn.isVisible()) {
    await settleBtn.click();
    await expect(page.getByRole('dialog', { name: /Settle Bill/ })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm Payment' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('PAID').first()).toBeVisible();
  }

  expect(pageErrors).toEqual([]);
});

