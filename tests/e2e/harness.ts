import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron,
  type ElectronApplication,
  expect,
  type Page,
  type Locator,
} from '@playwright/test';
import type { WindowKind } from '../../src/shared/ipc';
import { FIXTURE } from './fixture';

export interface Launched {
  app: ElectronApplication;
  /** Main-process stdout/stderr, for diagnosing failures. */
  mainLog: string[];
  userData: string;
  errors: string[];
  close(): Promise<void>;
}

/**
 * Launches the built app with an isolated profile. ANYSHOT_TEST exposes
 * `globalThis.__anyshot` in main, which tests drive through `app.evaluate`.
 */
export async function launch(
  args: string[] = [],
  settings: { capture?: Record<string, unknown> } & Record<string, unknown> = {},
  env: Record<string, string> = {},
): Promise<Launched> {
  const userData = await mkdtemp(join(tmpdir(), 'anyshot-e2e-'));
  let launched: ElectronApplication | undefined;
  try {
    // Most specs drive the edit tools on the selection, so instant preview starts on,
    // and instant capture starts off so renderer counts return to 0 immediately;
    // specs of the default flow pass `instantPreview: false` and instant specs pass `instantCapture: true`.
    const initial = {
      ...settings,
      capture: { instantPreview: true, instantCapture: false, ...settings.capture },
    };
    await writeFile(join(userData, 'settings.json'), JSON.stringify(initial));
    const errors: string[] = [];
    const app = await _electron.launch({
      args: ['.', ...args],
      env: {
        ...process.env,
        ANYSHOT_TEST: '1',
        ANYSHOT_USER_DATA: userData,
        XDG_CONFIG_HOME: join(userData, 'config'),
        ...env,
      },
    });
    launched = app;
    const context = app.context();
    const watch = (page: Page) => {
      page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`${page.url()}: ${message.text()}`);
      });
    };
    context.on('page', watch);
    for (const page of context.pages()) watch(page);
    context.on('requestfailed', (request) =>
      errors.push(
        `Failed request: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`,
      ),
    );
    context.on('response', (response) => {
      if (response.status() >= 400) {
        errors.push(`HTTP ${response.status()}: ${response.request().method()} ${response.url()}`);
      }
    });
    const mainLog: string[] = [];
    const proc = app.process();
    for (const stream of [proc.stdout, proc.stderr]) {
      stream?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          // Chromium's D-Bus noise under Xvfb is not interesting.
          if (line.trim() && !/dbus|Failed to adjust OOM/.test(line)) mainLog.push(line);
        }
      });
    }
    await expect
      .poll(() => app.evaluate(() => globalThis.__anyshot !== undefined), { timeout: 15_000 })
      .toBe(true);
    return {
      app,
      mainLog,
      userData,
      errors,
      async close() {
        await app.close().catch(() => {});
        await rm(userData, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await launched?.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyAndClose(ctx: Launched | undefined): Promise<void> {
  if (!ctx) return;
  try {
    expect(ctx.errors).toEqual([]);
  } finally {
    await ctx.close();
  }
}

export function processTypes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => globalThis.__anyshot?.processTypes() ?? []);
}

export function windowKinds(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => globalThis.__anyshot?.windows().map((w) => w.kind) ?? []);
}

export async function dispatch(app: ElectronApplication, action: string, file?: string) {
  await app.evaluate(
    (_electron, [action, file]) => globalThis.__anyshot?.dispatch(action as never, file),
    [action, file] as const,
  );
}

/** Waits for a window of the given kind and returns its page. */
export async function pageOf(app: ElectronApplication, kind: WindowKind): Promise<Page> {
  const match = () =>
    app.windows().find((p) => !p.isClosed() && p.url().includes(`app://local/${kind}/`));
  await expect.poll(() => match() !== undefined, { timeout: 15_000 }).toBe(true);
  const page = match();
  if (!page) throw new Error(`no ${kind} window`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

export function rendererCount(types: string[]): number {
  return types.filter((t) => t === 'Tab').length;
}

/** Presses a key that may close the page (e.g. Esc in the overlay). */
export async function pressClosing(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key).catch((error: Error) => {
    if (!/closed/i.test(error.message)) throw error;
  });
}

/** Clicks a control that closes its own window: the window may be gone before the click returns. */
export async function clickClosing(locator: Locator): Promise<void> {
  await locator.click().catch((error: Error) => {
    if (!/closed/i.test(error.message)) throw error;
  });
}

/** Starts an area capture and selects the fixture card; returns the overlay. */
export async function selectCard(app: ElectronApplication): Promise<Page> {
  await dispatch(app, 'captureArea');
  const overlay = await pageOf(app, 'overlay');
  await expect
    .poll(() =>
      app.evaluate(() =>
        globalThis.__anyshot?.windows().some((w) => w.kind === 'overlay' && w.visible),
      ),
    )
    .toBe(true);
  const { card } = FIXTURE;
  await overlay.mouse.move(card.x, card.y);
  await overlay.mouse.down();
  await overlay.mouse.move(card.x + card.width, card.y + card.height, { steps: 5 });
  await overlay.mouse.up();
  await expect(overlay.getByTestId('actions')).toBeVisible();
  return overlay;
}
