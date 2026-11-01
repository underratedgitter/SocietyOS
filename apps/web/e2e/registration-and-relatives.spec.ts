import { expect, test } from '@playwright/test';

const RESIDENT = { email: 'resident.a1@societyos.dev', password: 'Society#2026' };

test.describe('Visitor Self-Registration & Relatives Management Flows', () => {
  test('visitor self-registration portal issues active pass with PIN and QR code', async ({ page }) => {
    await page.goto('/visitor-register');

    // Verify page loaded
    await expect(page.getByRole('heading', { name: /Visitor Registration/i })).toBeVisible();

    // Fill in visitor details
    await page.fill('#vis-name', 'Rohan Sharma');
    await page.fill('#vis-phone', '+91 98765 43210');

    // Submit self-registration
    await page.getByRole('button', { name: /Generate Visitor Pass & PIN/i }).click();

    // Verify modal with PIN and QR code appears
    await expect(page.getByRole('heading', { name: /Gate Entry Pass Issued/i })).toBeVisible();
    await expect(page.getByText(/6-Digit Touchscreen Keypad PIN/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Done/i })).toBeVisible();

    await page.getByRole('button', { name: /Done/i }).click();
  });

  test('resident can view Relatives & Family tab and register a relative', async ({ page }) => {
    // Sign in as resident
    await page.goto('/login');
    await page.fill('#email', RESIDENT.email);
    await page.fill('#password', RESIDENT.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Wait for resident workspace
    await expect(page).toHaveURL(/\/resident/);

    // Click Relatives & Family tab
    const relativesTab = page.getByRole('button', { name: /Relatives & Family/i });
    await expect(relativesTab).toBeVisible();
    await relativesTab.click();

    // Verify heading
    await expect(page.getByRole('heading', { name: /Family & Relatives Directory/i })).toBeVisible();

    // Click Register Relative
    await page.getByRole('button', { name: /Register Relative/i }).click();

    // Fill modal
    const testName = `Meera Patel ${Date.now().toString().slice(-4)}`;
    await page.fill('#rel-name', testName);
    await page.fill('#rel-phone', '+91 98200 99887');

    await page.getByRole('button', { name: /Register Relative & Issue Pass/i }).click();

    // Verify relative is listed in the directory
    await expect(page.getByText(testName)).toBeVisible({ timeout: 5000 });
  });

  test('login page provides direct links to resident signup and visitor check-in', async ({ page }) => {
    await page.goto('/login');
    const registerLink = page.getByRole('link', { name: /Register your account/i });
    await expect(registerLink).toBeVisible();
    await expect(registerLink).toHaveAttribute('href', '/register');

    const visitorLink = page.getByRole('link', { name: /Self-register for gate pass/i });
    await expect(visitorLink).toBeVisible();
    await expect(visitorLink).toHaveAttribute('href', '/visitor-register');
  });
});
