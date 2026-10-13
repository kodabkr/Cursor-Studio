const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { CursorService } = require('./cursor-service.cjs');
const run = promisify(execFile);
let mainWindow;
let service;
let mutationBusy = false;

// Integration tests use a separate fixture and app-data directory, never the real installation.
const testing = !app.isPackaged && process.env.CURSOR_STUDIO_TEST_MODE === '1';
if (testing) {
  const fixtureBase = path.join(app.getAppPath(), '.test-runtime');
  for (const value of [process.env.CURSOR_STUDIO_TEST_ROOT, process.env.CURSOR_STUDIO_TEST_DATA]) {
    const relative = value && path.relative(fixtureBase, path.resolve(value));
    if (!value || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('UI tests require separate installation and app-data fixtures inside .test-runtime.');
    }
  }
  app.setPath('userData', path.resolve(process.env.CURSOR_STUDIO_TEST_DATA));
}

async function isRobloxRunning() {
  if (testing) return false;
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await run('tasklist.exe', ['/FI', 'IMAGENAME eq RobloxPlayerBeta.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 });
    return /^"RobloxPlayerBeta\.exe"/im.test(stdout);
  } catch {
    throw new Error('Could not check whether Roblox is running. Close Roblox and try again.');
  }
}

async function registeredRobloxRoot() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Classes\\roblox-player\\shell\\open\\command', '/ve'], { windowsHide: true, timeout: 5000 });
    const match = stdout.match(/"([^"\r\n]+\\RobloxPlayerBeta\.exe)"/i);
    return match ? path.dirname(match[1]) : null;
  } catch { return null; }
}

function inspectPng(bytes) {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('This PNG could not be decoded. Choose a valid PNG image.');
  return image.getSize();
}

function handle(channel, action, { mutation = false } = {}) {
  ipcMain.handle(channel, async (event, ...args) => {
    const expected = mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
    if (!expected) return { ok: false, error: 'This request is not allowed.' };
    if (mutation && mutationBusy) return { ok: false, error: 'Another cursor operation is still in progress.' };
    if (mutation) mutationBusy = true;
    try { return { ok: true, value: await action(...args) }; }
    catch (error) {
      console.error(`[${channel}]`, error.message);
      return { ok: false, error: error.message || 'The operation could not be completed.' };
    } finally { if (mutation) mutationBusy = false; }
  });
}

async function openFolder(folder) {
  const error = await shell.openPath(folder);
  if (error) throw new Error(error);
}

function registerApi(samplesPath) {
  handle('cursor:scan', async () => ({ installations: await service.scan(), running: await isRobloxRunning() }));
  handle('cursor:add-installation', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select your Roblox version folder',
      message: 'Choose the version folder containing RobloxPlayerBeta.exe.',
      properties: ['openDirectory']
    });
    return result.canceled ? null : service.addInstallation(result.filePaths[0]);
  });
  handle('cursor:stage', (filePath) => service.stageFile(filePath));
  handle('cursor:choose-png', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a cursor PNG', defaultPath: samplesPath,
      filters: [{ name: 'PNG images', extensions: ['png'] }], properties: ['openFile']
    });
    return result.canceled ? null : service.stageFile(result.filePaths[0]);
  });
  handle('cursor:apply', (request) => {
    if (!request || typeof request.installationId !== 'string' || !request.changes || typeof request.changes !== 'object' || Array.isArray(request.changes)) {
      throw new Error('Choose an installation and stage at least one PNG first.');
    }
    return service.apply(request.installationId, request.changes);
  }, { mutation: true });
  handle('cursor:restore', (request) => {
    if (!request || typeof request.installationId !== 'string' || (request.slotId != null && typeof request.slotId !== 'string')) throw new Error('Choose an installation to restore.');
    return service.restore(request.installationId, request.slotId);
  }, { mutation: true });
  handle('cursor:open-installation', async (id) => openFolder((await service.getInstallation(id)).root));
  handle('cursor:open-backups', async () => {
    const folder = path.join(app.getPath('userData'), 'backups');
    await fs.mkdir(folder, { recursive: true });
    return openFolder(folder);
  });
  handle('cursor:open-samples', async () => openFolder(samplesPath));
  handle('cursor:app-info', () => ({ version: app.getVersion(), samplesPath }));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 880, minWidth: 940, minHeight: 680,
    title: 'Cursor Studio', backgroundColor: '#111216', autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock() && !testing) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    service = new CursorService({
      dataDir: app.getPath('userData'),
      ...(testing ? { roots: [process.env.CURSOR_STUDIO_TEST_ROOT] } : {}),
      isRobloxRunning, inspectPng
    });
    if (!testing) {
      const root = await registeredRobloxRoot();
      if (root) {
        try { await service.addInstallation(root); } catch { /* Stale launcher registrations are ignored. */ }
      }
    }
    const downloadedSamples = path.join(app.getPath('downloads'), 'Roblox Cursor Samples');
    let samplesPath;
    if (await fs.access(downloadedSamples).then(() => true).catch(() => false)) {
      samplesPath = downloadedSamples;
    } else if (app.isPackaged) {
      samplesPath = path.join(app.getPath('userData'), 'test-cursors');
      await fs.cp(path.join(app.getAppPath(), 'assets', 'test-cursors'), samplesPath, { recursive: true, force: false });
    } else {
      samplesPath = path.join(app.getAppPath(), 'assets', 'test-cursors');
    }
    registerApi(samplesPath);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch((error) => {
    dialog.showErrorBox('Cursor Studio could not start', error.message);
    app.quit();
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
