const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const runRoot = path.join(root, '.test-runtime', `ui-${Date.now()}`);
const versions = path.join(runRoot, 'Versions');
const recent = path.join(versions, 'version-recent');
const old = path.join(versions, 'version-old');
const assets = path.join(root, 'assets', 'test-cursors');
const slots = ['Cursors/KeyboardMouse/ArrowFarCursor.png', 'Cursors/KeyboardMouse/ArrowCursor.png', 'Cursors/KeyboardMouse/IBeamCursor.png', 'MouseLockedCursor.png', 'Cursors/DragDetector/HoverCursor.png', 'Cursors/DragDetector/ActivatedCursor.png', 'Cursors/CrossMouseIcon.png', 'Cursors/Gamepad/Pointer.png', 'Cursors/Gamepad/PointerOver.png'];

async function makeInstall(folder, modifiedAt) {
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'RobloxPlayerBeta.exe'), 'TEST FIXTURE ONLY');
  for (const slot of slots) {
    const target = path.join(folder, 'content', 'textures', slot);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(assets, '01-normal-arrow.png'), target);
  }
  await fs.utimes(folder, modifiedAt, modifiedAt);
}

async function dropFile(page, card, filePath) {
  const input = page.locator('#smoke-file-input');
  if (!await input.count()) await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file'; input.id = 'smoke-file-input'; input.hidden = true;
    document.body.append(input);
  });
  await page.locator('#smoke-file-input').setInputFiles(filePath);
  await card.evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(document.querySelector('#smoke-file-input').files[0]);
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
}

(async () => {
  await makeInstall(old, new Date('2026-01-01T12:00:00Z'));
  await makeInstall(recent, new Date('2026-10-12T12:00:00Z'));
  const launchEnv = { ...process.env, CURSOR_STUDIO_TEST_MODE: '1', CURSOR_STUDIO_TEST_ROOT: versions, CURSOR_STUDIO_TEST_DATA: path.join(runRoot, 'data') };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: require('electron'), args: [root],
    env: launchEnv,
    timeout: 30000
  });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForSelector('.cursor-card', { timeout: 20000 });
    const scan = await page.evaluate(() => window.cursorStudio.scan());
    assert.equal(scan.installations[0].root, recent);
    assert.equal(scan.installations.length, 2);
    await fs.mkdir(path.join(root, 'test-output'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-output', 'app-initial.png'), fullPage: true });
    console.log('Installation detection passed: newest Windows folder modification date selected.');
    console.log('Cursor cards:', await page.locator('.cursor-card').count());
    await dropFile(page, page.locator('.cursor-card').first(), path.join(assets, '02-hover-hand.png'));
    await page.waitForSelector('.cursor-card.staged', { timeout: 10000 });
    await page.waitForFunction(() => {
      const normal = getComputedStyle(document.querySelector('#playground-area')).cursor;
      const hover = getComputedStyle(document.querySelector('.preview-target')).cursor;
      return normal.includes('url(') && hover.includes('url(') && normal !== hover;
    }, { timeout: 10000 });
    await page.screenshot({ path: path.join(root, 'test-output', 'app-staged.png'), fullPage: true });
    const applyButton = page.locator('#apply-button');
    await applyButton.click();
    await page.waitForFunction(() => !document.querySelector('.cursor-card.staged'), { timeout: 10000 });
    const target = path.join(recent, 'content', 'textures', slots[0]);
    assert.deepEqual(await fs.readFile(target), await fs.readFile(path.join(assets, '02-hover-hand.png')));
    const state = await page.evaluate(() => window.cursorStudio.scan());
    assert.ok(state.installations[0].cursors.find(cursor => cursor.id === 'normal').hasBackup);
    console.log('Drag/drop → native PNG validation → apply → backup passed.');
    await page.getByRole('button', { name: /^Backups/ }).click();
    await page.locator('#restore-all').click();
    await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(root, 'test-output', 'app-restore.png'), fullPage: true });
    await page.locator('#confirm-accept').click();
    await page.waitForFunction(() => document.querySelectorAll('.card-badge.modified').length === 0);
    assert.deepEqual(await fs.readFile(target), await fs.readFile(path.join(assets, '01-normal-arrow.png')));
    console.log('Backup screen and restore confirmation passed; original restored byte-for-byte.');
    await page.getByRole('button', { name: /^Cursors/ }).click();
    await page.setViewportSize({ width: 960, height: 720 });
    await page.screenshot({ path: path.join(root, 'test-output', 'app-compact.png'), fullPage: true });
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join('; ')}`);
    console.log('Electron UI smoke test passed; no renderer errors.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
