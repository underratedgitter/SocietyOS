import { expect, test, type Page } from '@playwright/test';

// These specs mock /api/v1 in the browser, so they need only the web server (no API or database).

const USER = {
  id: 'user-1',
  email: 'guard@example.dev',
  name: 'Gate Guard',
  isPlatformAdmin: false,
  mustChangePassword: false,
};

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function mockGuardSession(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill(
      json({
        user: USER,
        memberships: [
          {
            society: { id: 's1', name: 'Palm Grove', slug: 'palm-grove', timezone: 'Asia/Kolkata' },
            role: 'GUARD',
            status: 'ACTIVE',
          },
        ],
        flats: [],
      }),
    ),
  );
}

test('guard console clears a failed-load banner once a refresh succeeds', async ({ page }) => {
  await mockGuardSession(page);
  let overviewCalls = 0;
  await page.route('**/api/v1/societies/s1/overview', (route) => {
    overviewCalls += 1;
    if (overviewCalls === 1) return route.fulfill(json({ code: 'UNAVAILABLE', message: 'Gate service unavailable' }, 503));
    return route.fulfill(
      json({
        counts: { buildings: 1, flats: 1, residents: 1, activePasses: 0, pendingPasses: 0, devices: 0, onlineDevices: 0, openAlerts: 0, allowedToday: 0, deniedToday: 0 },
        recentEvents: [],
        policy: {},
        timezone: 'Asia/Kolkata',
        role: 'GUARD',
      }),
    );
  });
  await page.route('**/api/v1/societies/s1/access-points', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/societies/s1/devices', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/societies/s1/access-events**', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/societies/s1/gate-commands**', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/visitor-passes**', (route) => route.fulfill(json({ items: [], nextCursor: null })));

  await page.goto('/guard');
  await expect(page.getByText('Gate service unavailable')).toBeVisible();

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => overviewCalls).toBe(2);
  await expect(page.getByText('Gate service unavailable')).toHaveCount(0);
});

test('resident registration does not submit the previous society flat when the new flat list fails to load', async ({ page }) => {
  await page.route('**/api/v1/public/societies', (route) =>
    route.fulfill(
      json([
        { id: 's1', name: 'Palm Grove', slug: 'palm-grove' },
        { id: 's2', name: 'Lake View', slug: 'lake-view' },
      ]),
    ),
  );
  await page.route('**/api/v1/public/societies/s1/flats', (route) =>
    route.fulfill(json([{ id: 'flat-s1', label: 'A-101' }])),
  );
  await page.route('**/api/v1/public/societies/s2/flats', (route) =>
    route.fulfill(json({ code: 'UNAVAILABLE', message: 'down' }, 503)),
  );
  await page.route('**/api/v1/auth/me', (route) => route.fulfill(json({ message: 'no session' }, 401)));
  await page.route('**/api/v1/auth/refresh', (route) => route.fulfill(json({ message: 'no session' }, 401)));
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/api/v1/auth/register', (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill(json({ message: 'stop here' }, 400));
  });

  await page.goto('/register');
  await expect(page.locator('#reg-flat')).toHaveValue('flat-s1');
  await page.selectOption('#reg-society', 's2');
  await expect(page.getByText('No flats listed yet.')).toBeVisible();

  await page.fill('#reg-name', 'Test Resident');
  await page.fill('#reg-email', 'new@example.dev');
  await page.fill('#reg-password', 'long-enough-pass');
  await page.fill('#reg-confirm', 'long-enough-pass');
  await page.getByRole('button', { name: /Complete Registration/ }).click();

  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted).toMatchObject({ societyId: 's2' });
  expect((submitted as unknown as Record<string, unknown>).flatId).toBeUndefined();
});
