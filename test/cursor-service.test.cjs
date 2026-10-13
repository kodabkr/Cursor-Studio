'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const realpath = require('node:util').promisify(require('node:fs').realpath);
const path = require('node:path');
const zlib = require('node:zlib');
const { CursorService, validatePng } = require('../src/cursor-service.cjs');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, data.length + 8)), data.length + 8);
  return bytes;
}
function png(red = 0, width = 2, height = 2) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels[y * (width * 4 + 1) + 1 + x * 4] = red;
    pixels[y * (width * 4 + 1) + 4 + x * 4] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(__dirname, '.cursor-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(__dirname));
    assert.ok(path.basename(root).startsWith('.cursor-test-'));
    return fs.rm(root, { recursive: true, force: true });
  });
  const versions = path.join(root, 'Roblox', 'Versions');
  const installation = path.join(versions, 'version-test');
  const textures = path.join(installation, 'content', 'textures');
  const normal = path.join(textures, 'Cursors', 'KeyboardMouse', 'ArrowFarCursor.png');
  const hover = path.join(textures, 'Cursors', 'KeyboardMouse', 'ArrowCursor.png');
  const shiftLock = path.join(textures, 'MouseLockedCursor.png');
  await fs.mkdir(path.dirname(normal), { recursive: true });
  await fs.writeFile(path.join(installation, 'RobloxPlayerBeta.exe'), 'fake player');
  await fs.writeFile(normal, png(10));
  await fs.writeFile(hover, png(20));
  await fs.writeFile(shiftLock, png(30));
  await fs.writeFile(path.join(textures, 'unrelated.png'), png(40));
  const firstImage = path.join(root, 'replacement.png');
  const secondImage = path.join(root, 'replacement-2.png');
  await fs.writeFile(firstImage, png(100));
  await fs.writeFile(secondImage, png(200));
  const dataDir = path.join(root, 'app-data');
  const service = new CursorService({ dataDir, roots: [versions], ...options });
  return { root, installation, versions, textures, normal, hover, shiftLock, firstImage, secondImage, dataDir, service };
}

test('discovers validated installations and only existing recognized gameplay cursors', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.versions, 'version-studio', 'content', 'textures'), { recursive: true });
  await fs.writeFile(path.join(f.versions, 'version-studio', 'RobloxStudioBeta.exe'), 'studio');
  const installations = await f.service.scan();
  assert.equal(installations.length, 1);
  assert.equal(installations[0].root, await realpath(f.installation));
  assert.deepEqual(installations[0].cursors.map(cursor => cursor.id), ['normal', 'hover', 'shift-lock']);
  assert.equal(installations[0].cursors[0].width, 2);
  assert.equal(installations[0].cursors[0].modified, false);
  assert.equal(installations[0].writable, true);
});

test('stages validated PNG bytes without changing an installation', async t => {
  const f = await fixture(t, { inspectPng: bytes => validatePng(bytes) });
  const image = await f.service.stageFile(f.firstImage);
  assert.equal(image.name, 'replacement.png');
  assert.equal(image.width, 2);
  assert.ok(image.preview.startsWith('data:image/png;base64,'));
  assert.deepEqual(await fs.readFile(f.normal), png(10));
});

test('sorts by the version folder Date modified and does not change that date when applying', async t => {
  const f = await fixture(t);
  const newerFolder = path.join(f.versions, 'version-newer');
  const newerTextures = path.join(newerFolder, 'content', 'textures');
  await fs.mkdir(newerTextures, { recursive: true });
  await fs.writeFile(path.join(newerFolder, 'RobloxPlayerBeta.exe'), 'fake newer player');
  await fs.writeFile(path.join(newerTextures, 'ArrowFarCursor.png'), png(55));
  const olderTime = new Date('2025-01-01T12:00:00.000Z');
  const newerTime = new Date('2026-01-01T12:00:00.000Z');
  await fs.utimes(f.installation, olderTime, olderTime);
  await fs.utimes(newerFolder, newerTime, newerTime);
  // An executable with a newer timestamp must not override its version folder's timestamp.
  await fs.utimes(path.join(f.installation, 'RobloxPlayerBeta.exe'), new Date('2027-01-01T12:00:00Z'), new Date('2027-01-01T12:00:00Z'));
  const installations = await f.service.scan();
  assert.equal(installations[0].root, await realpath(newerFolder));
  assert.equal(installations[0].modifiedAt, newerTime.toISOString());
  const staged = await f.service.stageFile(f.firstImage);
  const applied = await f.service.apply(installations[0].id, { normal: staged.id });
  assert.equal(applied.modifiedAt, newerTime.toISOString());
});

test('updates all existing modern and legacy variants and restores each distinct original', async t => {
  const f = await fixture(t);
  const legacyNormal = path.join(f.textures, 'ArrowFarCursor.png');
  await fs.writeFile(legacyNormal, png(77));
  const [installation] = await f.service.scan();
  assert.equal(installation.cursors.find(cursor => cursor.id === 'normal').relativePaths.length, 2);
  const staged = await f.service.stageFile(f.firstImage);
  await f.service.apply(installation.id, { normal: staged.id });
  assert.deepEqual(await fs.readFile(f.normal), png(100));
  assert.deepEqual(await fs.readFile(legacyNormal), png(100));
  await f.service.restore(installation.id, 'normal');
  assert.deepEqual(await fs.readFile(f.normal), png(10));
  assert.deepEqual(await fs.readFile(legacyNormal), png(77));
});

test('preserves originals across repeated apply and new app sessions, then restores', async t => {
  const f = await fixture(t);
  const [installation] = await f.service.scan();
  const first = await f.service.stageFile(f.firstImage);
  const second = await f.service.stageFile(f.secondImage);
  let changed = await f.service.apply(installation.id, { normal: first.id, hover: first.id });
  assert.equal(changed.cursors.find(cursor => cursor.id === 'normal').modified, true);
  assert.deepEqual(await fs.readFile(f.normal), png(100));
  await f.service.apply(installation.id, { normal: second.id });
  assert.deepEqual(await fs.readFile(f.normal), png(200));
  const restarted = new CursorService({ dataDir: f.dataDir, roots: [f.versions] });
  const [afterRestart] = await restarted.scan();
  assert.equal(afterRestart.id, installation.id);
  assert.deepEqual(await fs.readFile(f.normal), png(200), 'startup must not auto-restore');
  changed = await restarted.restore(installation.id, 'normal');
  assert.equal(changed.cursors.find(cursor => cursor.id === 'normal').modified, false);
  assert.equal(changed.cursors.find(cursor => cursor.id === 'hover').modified, true);
  assert.deepEqual(await fs.readFile(f.normal), png(10));
  await restarted.restore(installation.id);
  assert.deepEqual(await fs.readFile(f.hover), png(20));
  assert.deepEqual(await fs.readFile(f.shiftLock), png(30));
});

test('rejects renamed, corrupt, truncated, oversized, and undecodable PNG files', async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from('not a PNG'), png().subarray(0, 30), Buffer.from(png()), png(5, 1025, 1)]) {
    if (bytes.length === png().length) bytes[45] ^= 1;
    const invalid = path.join(f.root, 'invalid.png');
    await fs.writeFile(invalid, bytes);
    await assert.rejects(f.service.stageFile(invalid), { code: 'INVALID_PNG' });
  }
  const validWrongName = path.join(f.root, 'image.jpg');
  await fs.writeFile(validWrongName, png());
  await assert.rejects(f.service.stageFile(validWrongName), { code: 'INVALID_PNG' });
  const decoderRejects = new CursorService({ dataDir: f.dataDir, roots: [], inspectPng: () => null });
  await assert.rejects(decoderRejects.stageFile(f.firstImage), { code: 'INVALID_PNG' });
});

test('rejects unknown slot IDs, unknown staged IDs, and changes while Roblox is running', async t => {
  let running = false;
  const f = await fixture(t, { isRobloxRunning: async () => running });
  const [installation] = await f.service.scan();
  const staged = await f.service.stageFile(f.firstImage);
  await assert.rejects(f.service.apply(installation.id, { '../../escape': staged.id }), { code: 'INVALID_SLOT' });
  await assert.rejects(f.service.apply(installation.id, { normal: '../../escape' }), { code: 'STAGED_IMAGE_NOT_FOUND' });
  running = true;
  await assert.rejects(f.service.apply(installation.id, { normal: staged.id }), { code: 'ROBLOX_RUNNING' });
  await assert.rejects(f.service.restore(installation.id), { code: 'ROBLOX_RUNNING' });
  assert.deepEqual(await fs.readFile(f.normal), png(10));
});

test('rolls back all previously written cursors when a later write fails', async t => {
  const f = await fixture(t);
  const [installation] = await f.service.scan();
  const staged = await f.service.stageFile(f.firstImage);
  const originalWrite = f.service._atomicWrite.bind(f.service);
  let didFail = false;
  f.service._atomicWrite = async (target, bytes, mode) => {
    if (target === await realpath(f.hover) && !didFail) {
      didFail = true;
      const error = new Error('simulated file lock');
      error.code = 'EBUSY';
      throw error;
    }
    return originalWrite(target, bytes, mode);
  };
  await assert.rejects(f.service.apply(installation.id, { normal: staged.id, hover: staged.id }), { code: 'WRITE_FAILED' });
  assert.deepEqual(await fs.readFile(f.normal), png(10));
  assert.deepEqual(await fs.readFile(f.hover), png(20));
  assert.equal((await f.service.getInstallation(installation.id)).cursors.find(cursor => cursor.id === 'normal').hasBackup, true);
});

test('detects damaged backups before restoring any cursor', async t => {
  const f = await fixture(t);
  const [installation] = await f.service.scan();
  const staged = await f.service.stageFile(f.firstImage);
  await f.service.apply(installation.id, { normal: staged.id, hover: staged.id });
  const manifest = JSON.parse(await fs.readFile(path.join(f.dataDir, 'backups', installation.id, 'manifest.json'), 'utf8'));
  const entry = manifest.files['content/textures/Cursors/KeyboardMouse/ArrowCursor.png'];
  await fs.writeFile(path.join(f.dataDir, 'backups', installation.id, entry.file), png(99));
  await assert.rejects(f.service.restore(installation.id), { code: 'BACKUP_DAMAGED' });
  assert.deepEqual(await fs.readFile(f.normal), png(100));
  assert.deepEqual(await fs.readFile(f.hover), png(100));
});

for (const condition of ['missing', 'corrupted']) {
  test(`rejects another apply when an existing selected original is ${condition}, before making any backup or target changes`, async t => {
    const f = await fixture(t);
    const [installation] = await f.service.scan();
    const first = await f.service.stageFile(f.firstImage);
    const second = await f.service.stageFile(f.secondImage);
    await f.service.apply(installation.id, { normal: first.id });
    const manifestPath = path.join(f.dataDir, 'backups', installation.id, 'manifest.json');
    const manifestBytes = await fs.readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    const entry = manifest.files['content/textures/Cursors/KeyboardMouse/ArrowFarCursor.png'];
    const backupPath = path.join(f.dataDir, 'backups', installation.id, entry.file);
    if (condition === 'missing') await fs.unlink(backupPath);
    else await fs.writeFile(backupPath, png(99));
    const backupFilesBefore = await fs.readdir(path.dirname(manifestPath));
    await assert.rejects(f.service.apply(installation.id, { hover: second.id, normal: second.id }), { code: 'BACKUP_DAMAGED' });
    assert.deepEqual(await fs.readFile(f.normal), png(100));
    assert.deepEqual(await fs.readFile(f.hover), png(20));
    assert.deepEqual(await fs.readFile(manifestPath), manifestBytes);
    assert.deepEqual(await fs.readdir(path.dirname(manifestPath)), backupFilesBefore);
    await assert.rejects(f.service.restore(installation.id), { code: 'BACKUP_DAMAGED' });
  });
}

test('persists explicitly selected installations and rejects Studio or arbitrary folders', async t => {
  const f = await fixture(t);
  const manual = new CursorService({ dataDir: f.dataDir, roots: [] });
  const installation = await manual.addInstallation(f.installation);
  const restarted = new CursorService({ dataDir: f.dataDir, roots: [] });
  assert.equal((await restarted.scan())[0].id, installation.id);
  await assert.rejects(manual.addInstallation(f.root), { code: 'INVALID_INSTALLATION' });
});

test('rejects cursor symlinks pointing outside the installation', async t => {
  const f = await fixture(t);
  const [installation] = await f.service.scan();
  const staged = await f.service.stageFile(f.firstImage);
  await fs.unlink(f.normal);
  try { await fs.symlink(f.firstImage, f.normal, 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Creating file symlinks requires Windows developer mode.'); throw error; }
  await assert.rejects(f.service.apply(installation.id, { normal: staged.id }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readFile(f.firstImage), png(100));
});

test('rejects backup directory junctions that escape the app data directory', async t => {
  const f = await fixture(t);
  const [installation] = await f.service.scan();
  const staged = await f.service.stageFile(f.firstImage);
  const destination = path.join(f.root, 'outside-backups');
  await fs.mkdir(destination);
  const backupFolder = path.join(f.dataDir, 'backups', installation.id);
  await fs.rm(backupFolder, { recursive: true, force: true });
  try { await fs.symlink(destination, backupFolder, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Creating links is unavailable.'); throw error; }
  await assert.rejects(f.service.apply(installation.id, { normal: staged.id }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readFile(f.normal), png(10));
  assert.deepEqual(await fs.readdir(destination), []);
});
