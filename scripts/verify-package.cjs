const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CURSOR_STUDIO_TEST_MODE;
  delete env.CURSOR_STUDIO_TEST_ROOT;
  delete env.CURSOR_STUDIO_TEST_DATA;
  const app = await electron.launch({ executablePath: path.join(root, 'release', 'win-unpacked', 'Cursor Studio.exe'), env, timeout: 30000 });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.cursor-card', { timeout: 20000 });
    const state = await page.evaluate(() => window.cursorStudio.scan());
    assert.ok(state.installations.length, 'No real Player installation was detected');
    const newest = [...state.installations].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0];
    assert.equal(await page.locator('#installation-select').inputValue(), newest.id);
    assert.equal(await page.locator('.cursor-card').count(), newest.cursors.length);
    await page.waitForFunction(() => [...document.querySelectorAll('.cursor-card img')].every(img => img.complete && img.naturalWidth > 0));
    await fs.mkdir(path.join(root, 'test-output'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-output', 'packaged-app.png'), fullPage: true });
    console.log(`Packaged app selected ${newest.version}, folder modified ${newest.modifiedAt}, with ${newest.cursors.length} actual cursor slots.`);
    console.log('Read-only package verification passed. No Roblox cursor files were changed.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
