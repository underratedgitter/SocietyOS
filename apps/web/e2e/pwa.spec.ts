import { execSync } from 'node:child_process';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

async function provisionTestFlat(request: APIRequestContext): Promise<{ flatId: string; label: string }> {
  const loginResponse = await request.post('/api/v1/auth/login', { data: ADMIN });
  expect(loginResponse.ok()).toBeTruthy();

  const societies = (await (await request.get('/api/v1/societies')).json()) as {
    id: string;
    name: string;
    role: string;
  }[];
  const society = societies.find((entry) => entry.role === 'SOCIETY_ADMIN');
  expect(society).toBeDefined();

  const buildings = (await (
    await request.get(`/api/v1/societies/${society!.id}/buildings`)
  ).json()) as { id: string; name: string }[];
  let building = buildings.find((entry) => entry.name === 'PWA Test Wing');
  if (!building) {
    const created = await request.post(`/api/v1/societies/${society!.id}/buildings`, {
      data: { name: 'PWA Test Wing' },
    });
    expect(created.ok()).toBeTruthy();
    building = (await created.json()) as { id: string; name: string };
  }

  const flatNumber = `PWA-${Date.now().toString().slice(-6)}`;
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

test('PWA manifest, service worker, icons, and Apple mobile web app metadata are correctly served', async ({
  page,
  request,
}) => {
  // 1. Verify Next.js Web App Manifest route
  const manifestRes = await request.get('/manifest.webmanifest');
  expect(manifestRes.ok()).toBeTruthy();
  const manifest = await manifestRes.json();
  expect(manifest.name).toBe('SocietyOS Resident');
  expect(manifest.short_name).toBe('SocietyOS');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/resident');
  expect(manifest.icons).toBeDefined();
  expect(manifest.icons.length).toBeGreaterThanOrEqual(3);

  // 2. Verify static manifest.json fallback route
  const manifestJsonRes = await request.get('/manifest.json');
  expect(manifestJsonRes.ok()).toBeTruthy();
  const manifestJson = await manifestJsonRes.json();
  expect(manifestJson.name).toBe('SocietyOS Resident');

  // 3. Verify Service Worker asset
  const swRes = await request.get('/sw.js');
  expect(swRes.ok()).toBeTruthy();
  expect(swRes.headers()['content-type']).toContain('javascript');

  // 4. Verify icon assets exist and return image content
  const icon192 = await request.get('/icons/icon-192x192.png');
  expect(icon192.ok()).toBeTruthy();
  expect(icon192.headers()['content-type']).toContain('image/png');

  const icon512 = await request.get('/icons/icon-512x512.png');
  expect(icon512.ok()).toBeTruthy();

  const appleTouchIcon = await request.get('/icons/apple-touch-icon.png');
  expect(appleTouchIcon.ok()).toBeTruthy();

  // 5. Verify HTML meta tags for Apple Web App and Manifest
  await page.goto('/login');
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', '/manifest.webmanifest');

  const capableMeta = page
    .locator('meta[name="apple-mobile-web-app-capable"], meta[name="mobile-web-app-capable"]')
    .first();
  await expect(capableMeta).toHaveAttribute('content', 'yes');

  const appleIconLink = page.locator('link[rel="apple-touch-icon"]');
  await expect(appleIconLink).toHaveAttribute('href', '/icons/apple-touch-icon.png');
});

test('resident creates visitor pass with quick presets, vehicle, purpose, and native share integration', async ({
  page,
  request,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const testFlat = await provisionTestFlat(request);

  await login(page, RESIDENT);
  await expect(page).toHaveURL(/\/resident$/);

  const flatSelect = page.locator('select[aria-label="Select flat"]');
  await flatSelect.selectOption(testFlat.flatId);

  // Verify prominent "+ New Pass" / "Invite a visitor" triggers modal
  const inviteBtn = page.getByRole('button', { name: /Invite a visitor/ }).first();
  await expect(inviteBtn).toBeVisible();
  await inviteBtn.click();

  await expect(page.getByRole('dialog', { name: 'Invite a visitor' })).toBeVisible();

  // Test Fast Preset Chip (Delivery)
  const deliveryPreset = page.getByRole('button', { name: /Delivery \(20m\)/ });
  await expect(deliveryPreset).toBeVisible();
  await deliveryPreset.click();

  // Fields should be populated with preset values
  await expect(page.locator('#pass-category')).toHaveValue('DELIVERY');
  await expect(page.locator('#pass-name')).toHaveValue('Delivery Partner');
  await expect(page.locator('#pass-purpose')).toHaveValue('Parcel Delivery');

  // Fill in vehicle and custom name
  await page.fill('#pass-name', 'Zomato Rider');
  const testPhone = '+91 98765 00112';
  await page.fill('#pass-phone', testPhone);
  await page.fill('#pass-vehicle', 'MH 02 CZ 4411');

  // Submit pass
  await page.getByRole('button', { name: /Issue visitor pass/ }).click();

  // Modal opens with issued credentials and vehicle
  const dialog = page.getByRole('dialog', { name: 'Visitor pass issued' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Zomato Rider', { exact: true })).toBeVisible();
  await expect(dialog.getByText('MH 02 CZ 4411')).toBeVisible();

  // Verify PIN is generated
  const pinEl = dialog.locator('.pass-card-pin');
  await expect(pinEl).toBeVisible();
  const pin = await pinEl.innerText();
  expect(pin).toMatch(/^\d{6}$/);

  // Verify Share button and WhatsApp button
  const shareBtn = dialog.getByRole('button', { name: /Share/i }).first();
  await expect(shareBtn).toBeVisible();

  const waLink = dialog.locator('a[href*="wa.me"]');
  await expect(waLink).toBeVisible();
  const waHref = await waLink.getAttribute('href');
  expect(waHref).toContain('MH%2002%20CZ%204411');
  expect(waHref).toContain(pin);
  // Phone numbers digits should be formatted into WhatsApp link when provided
  expect(waHref).toContain('919876500112');

  // Close modal
  await dialog.getByRole('button', { name: 'I have shared it' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('mobile viewport provides Floating Action Button and hides desktop-only elements', async ({
  page,
  request,
}) => {
  await provisionTestFlat(request);
  await login(page, RESIDENT);
  await expect(page).toHaveURL(/\/resident$/);

  // 1. Mobile viewport (390 x 844, iPhone standard)
  await page.setViewportSize({ width: 390, height: 844 });
  const fab = page.locator('.mobile-fab');
  await expect(fab).toBeVisible();
  await expect(fab).toHaveText(/New Pass/i);

  // Click FAB opens visitor invitation modal
  await fab.click();
  await expect(page.getByRole('dialog', { name: 'Invite a visitor' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  // 2. Desktop viewport (1280 x 800)
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(fab).toBeHidden();
});

test('PWA install prompt handles simulated Chrome beforeinstallprompt and dismissal', async ({
  page,
  request,
}) => {
  await provisionTestFlat(request);
  await login(page, RESIDENT);
  await expect(page).toHaveURL(/\/resident$/);

  // Banner should not be visible before prompt
  const banner = page.locator('.pwa-install-banner');
  await expect(banner).toHaveCount(0);

  // Simulate Chromium beforeinstallprompt event
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt') as any;
    event.prompt = async () => {};
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(event);
  });

  // Banner appears with Install button
  await expect(banner).toBeVisible();
  const installBtn = banner.getByRole('button', { name: /Install App/i });
  await expect(installBtn).toBeVisible();

  // Clicking Install App triggers installation prompt
  await installBtn.click();
  // Banner clears upon prompt consumption
  await expect(banner).toHaveCount(0);
});

test('iOS Safari emulation displays step-by-step installation guide', async ({ browser, request }) => {
  await provisionTestFlat(request);

  // Create context mimicking mobile Safari on iPhone
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });

  const page = await context.newPage();
  await login(page, RESIDENT);
  await expect(page).toHaveURL(/\/resident$/);

  // iOS install banner is displayed automatically
  const banner = page.locator('.pwa-install-banner');
  await expect(banner).toBeVisible();

  // Tap "Install App" on iOS
  const installBtn = banner.getByRole('button', { name: /Install App/i });
  await expect(installBtn).toBeVisible();
  await installBtn.click();

  // Modal opens with 3-step guide
  const modal = page.locator('.pwa-ios-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByText('Install SocietyOS on iPhone & iPad')).toBeVisible();
  await expect(modal.getByText(/Tap the Share button/i)).toBeVisible();
  await expect(modal.getByText(/Add to Home Screen/i)).toBeVisible();

  // Dismiss modal via "Got it" button
  await modal.getByRole('button', { name: 'Got it' }).click();
  await expect(modal).toHaveCount(0);

  // Dismiss banner via X button
  await banner.getByLabel('Dismiss install banner').click();
  await expect(banner).toHaveCount(0);

  await context.close();
});
