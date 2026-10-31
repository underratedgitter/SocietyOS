import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const RESIDENT = { email: 'resident.a1@societyos.dev', password: 'Society#2026' };
const GUARD = { email: 'guard.a@societyos.dev', password: 'GuardA#2026' };
const ADMIN = { email: 'admin.a@societyos.dev', password: 'AdminA#2026' };

async function login(page: Page, credentials: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.fill('#email', credentials.email);
  await page.fill('#password', credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/**
 * Gives the seeded resident a fresh flat so repeated runs never collide with
 * the per-flat daily invitation limit. This mirrors how an administrator adds
 * a household member and keeps the suite independent of prior test data.
 */
async function provisionTestFlat(request: APIRequestContext): Promise<{ flatId: string; label: string }> {
  const loginResponse = await request.post('/api/v1/auth/login', { data: ADMIN });
  expect(loginResponse.ok()).toBeTruthy();

  const societies = (await (await request.get('/api/v1/societies')).json()) as {
    id: string;
    name: string;
    role: string;
  }[];
  const society = societies.find((entry) => entry.role === 'SOCIETY_ADMIN');
  expect(society, 'seeded administrator has a society').toBeDefined();

  const buildings = (await (
    await request.get(`/api/v1/societies/${society!.id}/buildings`)
  ).json()) as { id: string; name: string }[];
  let building = buildings.find((entry) => entry.name === 'Automation Wing');
  if (!building) {
    const created = await request.post(`/api/v1/societies/${society!.id}/buildings`, {
      data: { name: 'Automation Wing' },
    });
    expect(created.ok()).toBeTruthy();
    building = (await created.json()) as { id: string; name: string };
  }

  const flatNumber = `E2E-${Date.now().toString().slice(-6)}`;
  const flatResponse = await request.post(`/api/v1/buildings/${building.id}/flats`, {
    data: { flatNumber },
  });
  expect(flatResponse.ok()).toBeTruthy();
  const flat = (await flatResponse.json()) as { id: string };

  const membership = await request.post(`/api/v1/flats/${flat.id}/members`, {
    data: { name: 'Meera Iyer', email: RESIDENT.email, relationship: 'FAMILY' },
  });
  expect(membership.ok()).toBeTruthy();
  return { flatId: flat.id, label: `${building.name} · ${flatNumber}` };
}

test('resident issues a pass, guard verifies it, kiosk denies an unknown PIN', async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const testFlat = await provisionTestFlat(request);

  await login(page, RESIDENT);
  await expect(page).toHaveURL(/\/resident$/);
  await expect(page.getByRole('heading', { name: 'Visitors' })).toBeVisible();
  const flatSelect = page.locator('select[aria-label="Select flat"]');
  await flatSelect.selectOption(testFlat.flatId);
  await expect(flatSelect).toHaveValue(testFlat.flatId);

  await page.getByRole('button', { name: /Invite a visitor/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Invite a visitor' })).toBeVisible();
  await page.fill('#pass-name', `Playwright Visitor ${Date.now()}`);
  await page.selectOption('#pass-category', 'FRIEND');
  await page.getByRole('button', { name: /Issue visitor pass/ }).click();

  await expect(page.getByRole('dialog', { name: 'Visitor pass issued' })).toBeVisible();
  const credentialText = await page.locator('.credential-callout').innerText();
  const pinMatch = credentialText.match(/PIN\s*(\d{6})/);
  expect(pinMatch, 'issued credential shows a six-digit PIN').not.toBeNull();
  const pin = pinMatch![1];
  expect(credentialText).toContain('QR token');

  await page.getByRole('button', { name: 'I have shared it' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Current and upcoming')).toBeVisible();

  await logout(page);
  await login(page, GUARD);
  await expect(page).toHaveURL(/\/guard$/);
  await expect(page.getByRole('heading', { name: 'Guard console' })).toBeVisible();

  await page.fill('#verify-credential', pin);
  await page.getByRole('button', { name: 'Verify at gate' }).click();
  await expect(page.getByText('Entry allowed')).toBeVisible();
  await expect(page.getByText('Entry denied')).toHaveCount(0);

  await page.goto('/kiosk');
  await expect(page.getByText('Gate check')).toBeVisible();
  const keypad = page.locator('.keypad .key');
  for (let index = 0; index < 5; index += 1) {
    await keypad.nth(10).click(); // "0"
  }
  await keypad.nth(0).click(); // "1"
  await page.getByRole('button', { name: 'Verify PIN' }).click();
  await expect(page.getByText('Entry denied')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('admin console loads the command view and society settings', async ({ page }) => {
  await login(page, ADMIN);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Command view' })).toBeVisible();
  await expect(page.getByText('Active passes', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Society profile')).toBeVisible();
  await expect(page.getByText('Visitor approval policy')).toBeVisible();
});

test('guard console gate controls and kiosk biometric resident mode', async ({ page }) => {
  await login(page, GUARD);
  await expect(page).toHaveURL(/\/guard$/);
  await expect(page.getByRole('heading', { name: 'Guard console' })).toBeVisible();

  // Test Gate Visualizer and Pulse control
  const pulseButton = page.getByRole('button', { name: /Open Gate Pulse/ });
  await expect(pulseButton).toBeVisible();
  await pulseButton.click();
  await expect(page.getByText(/Gate opened for 10-second pulse/)).toBeVisible();

  // Test Kiosk Biometric Mode
  await page.goto('/kiosk');
  await expect(page.getByText('Gate check')).toBeVisible();
  const bioTab = page.getByRole('button', { name: /Resident Biometric/ });
  await expect(bioTab).toBeVisible();
  await bioTab.click();
  await expect(page.getByText(/Touch Reader or Look at Face Sensor/)).toBeVisible();
});
