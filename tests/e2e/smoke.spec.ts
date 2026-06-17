import { test, expect } from '@playwright/test';

test.describe('Health check', () => {
  test('API health endpoint returns ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.name).toBe('webmux');
  });

  test('auth status reports mode none', async ({ request }) => {
    const res = await request.get('/api/auth/status');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.mode).toBe('none');
  });
});

test.describe('UI loads', () => {
  test('serves index.html with correct title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('WebMux');
  });

  test('skips login in no-auth mode and shows workspace', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('agent-session-list')).toBeVisible({ timeout: 10_000 });
  });

  test('top bar renders with logo and controls', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('agent-session-list')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=WebMux').first()).toBeVisible();
    await expect(page.locator('text=Type to All')).toBeVisible();
  });

  test('add cell opens connection dialog on click', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Terminals' }).click();
    // Both panes render add-cell-0-0; .first() targets the terminals pane.
    const addCell = page.getByTestId('add-cell-0-0').first();
    await expect(addCell).toBeVisible({ timeout: 10_000 });

    await addCell.click();
    await expect(page.locator('text=Connect to Host')).toBeVisible();
  });

  test('config endpoint returns valid app config', async ({ request }) => {
    // Auth mode is none, but config endpoint still needs a token for the
    // middleware to pass — in "none" mode, middleware lets everything through.
    const res = await request.get('/api/config');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.app).toBeDefined();
    expect(body.app.default_term).toBeDefined();
    expect(body.app.default_term.cols).toBe(80);
  });

  test('agents pane renders vertical list, sorts, and selects sessions', async ({ page }) => {
    const attachRequests: { kind: string; name: string }[] = [];
    await page.route('**/api/agents/sessions', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          name: 'codex-old-2026-06-14-15-08-55',
          kind: 'codex',
          display_name: 'old',
          windows: 1,
          attached: 0,
          created_at: '2026-06-14T22:08:55.000Z',
          last_output_at: '2026-06-14T22:08:55.000Z',
          status: 'waiting',
          status_source: 'hook',
        },
        {
          name: 'claude-new-2026-06-16-15-08-55',
          kind: 'claude',
          display_name: 'new',
          windows: 1,
          attached: 0,
          created_at: '2026-06-16T22:08:55.000Z',
          last_output_at: '2026-06-17T20:08:55.000Z',
          status: 'waiting',
          status_source: 'hook',
        },
      ]),
    }));
    await page.route(/\/api\/agents\/(codex|claude)\/attach$/, async route => {
      const kind = route.request().url().includes('/claude/') ? 'claude' : 'codex';
      const body = route.request().postDataJSON() as { name: string };
      attachRequests.push({ kind, name: body.name });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: `${kind}-attach`,
          kind: 'terminal',
          owner: 'anonymous',
          transport: 'exec',
          host_id: '',
          hostname: `${kind}.local`,
          username: kind,
          key_id: '',
          cols: 120,
          rows: 40,
          row: 0,
          col: 0,
          port: 0,
          state: 'connected',
          created_at: '',
          updated_at: '',
          title: body.name,
          persistent: false,
          minimized: false,
          workspace: kind === 'codex' ? 'codexes' : 'claudes',
          agent_kind: kind,
          agent_role: 'attach',
          agent_session_name: body.name,
        }),
      });
    });

    await page.goto('/');
    const rows = page.getByTestId('agent-session-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('new');
    await expect(rows.nth(1)).toContainText('old');

    const firstBox = await rows.nth(0).boundingBox();
    const secondBox = await rows.nth(1).boundingBox();
    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    expect(secondBox!.y).toBeGreaterThan(firstBox!.y);
    expect(Math.abs(secondBox!.x - firstBox!.x)).toBeLessThan(2);

    await page.setViewportSize({ width: 820, height: 1180 });
    const tabletFirstBox = await rows.nth(0).boundingBox();
    const tabletSecondBox = await rows.nth(1).boundingBox();
    expect(tabletFirstBox).not.toBeNull();
    expect(tabletSecondBox).not.toBeNull();
    expect(tabletSecondBox!.y).toBeGreaterThan(tabletFirstBox!.y);
    expect(Math.abs(tabletSecondBox!.x - tabletFirstBox!.x)).toBeLessThan(2);

    await page.getByLabel('Sort agent sessions').selectOption('waiting-longest');
    await expect(rows.nth(0)).toContainText('old');

    await rows.nth(1).click();
    await expect.poll(() => attachRequests.some(req => req.kind === 'claude' && req.name === 'claude-new-2026-06-16-15-08-55')).toBe(true);
  });
});
