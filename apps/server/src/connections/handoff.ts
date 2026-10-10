/**
 * The pages the default browser sees during the desktop app's handoff (ADR 0033):
 * the confirmation that names the account a vendor is about to be connected to,
 * and the end of the flow. Plain server-rendered HTML: the browser here has no
 * Fabrikka login, so the web app can't render them.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { users } from '@fabrikka/db';
import { handoffPath } from './oauth.ts';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export async function accountEmail(db: Database, userId: string): Promise<string | null> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return row?.email ?? null;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · Fabrikka</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #293241;
    background: radial-gradient(800px 500px at 0% 0%, rgba(152,193,217,.45), rgba(152,193,217,0) 65%),
      radial-gradient(700px 480px at 100% 0%, rgba(238,108,77,.14), rgba(238,108,77,0) 60%), #f4fafc;
  }
  main {
    width: min(420px, 100%); box-sizing: border-box; padding: 28px; border-radius: 20px; background: #fff;
    border: 1px solid rgba(201,221,232,.8); box-shadow: 0 18px 40px -18px rgba(61,90,128,.45);
    display: flex; flex-direction: column; gap: 14px;
  }
  h1 { margin: 0; font-size: 1.3rem; letter-spacing: -0.02em; }
  p { margin: 0; line-height: 1.5; color: #5d6d82; }
  strong { color: #293241; }
  button {
    font: inherit; font-weight: 600; color: #fff; cursor: pointer; padding: 0.7rem 1rem; min-height: 44px;
    border: 0; border-radius: 12px; width: 100%;
    background: linear-gradient(120deg, #2f4a6e 0%, #3d5a80 45%, #5a7fa8 100%);
    box-shadow: 0 8px 20px -10px rgba(61,90,128,.75);
  }
  button:focus-visible { outline: 2px solid #3d5a80; outline-offset: 2px; }
  .bad { color: #c4492b; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/** Step 3: name the account, and start only on the person's own Continue. */
export function confirmPage(opts: { vendor: string; email: string; ticket: string }): string {
  return page(
    `Connect ${opts.vendor}`,
    `<h1>Connect ${esc(opts.vendor)}</h1>
<p>This connects your ${esc(opts.vendor)} account to the Fabrikka account <strong>${esc(opts.email)}</strong>.</p>
<p>If that isn't you, close this tab.</p>
<form method="post" action="${handoffPath}">
<input type="hidden" name="t" value="${esc(opts.ticket)}">
<button type="submit">Continue to ${esc(opts.vendor)}</button>
</form>`,
  );
}

export function donePage(vendor: string): string {
  return page(
    `${vendor} connected`,
    `<h1>${esc(vendor)} is connected</h1>
<p>You can close this tab and go back to the Fabrikka app.</p>`,
  );
}

export function failedPage(message: string): string {
  return page(
    'Not connected',
    `<h1>Not connected</h1>
<p class="bad">${esc(message)}</p>
<p>Go back to the Fabrikka app and press Connect again.</p>`,
  );
}
