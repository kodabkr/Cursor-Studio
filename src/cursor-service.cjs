'use strict';

const fs = require('node:fs/promises');
const realpath = require('node:util').promisify(require('node:fs').realpath);
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CURSOR_SLOTS = [
  { id: 'normal', label: 'Normal pointer', description: 'The pointer over the world and non-interactive surfaces.', paths: ['Cursors/KeyboardMouse/ArrowFarCursor.png', 'ArrowFarCursor.png'] },
  { id: 'hover', label: 'Hover pointer', description: 'The pointer over an interactive object or button.', paths: ['Cursors/KeyboardMouse/ArrowCursor.png', 'ArrowCursor.png'] },
  { id: 'drag-hover', label: 'Drag hover', description: 'The hover pointer over a draggable object.', paths: ['Cursors/DragDetector/HoverCursor.png'] },
  { id: 'drag-pressed', label: 'Drag pressed', description: 'The active pointer while pressing and dragging an object.', paths: ['Cursors/DragDetector/ActivatedCursor.png'] },
  { id: 'text', label: 'Text cursor', description: 'The I-beam shown when entering text.', paths: ['Cursors/KeyboardMouse/IBeamCursor.png', 'IBeamCursor.png'] },
  { id: 'shift-lock', label: 'Shift-lock', description: 'The centered cursor used with shift-lock enabled.', paths: ['MouseLockedCursor.png', 'Cursors/KeyboardMouse/MouseLockedCursor.png'] },
  { id: 'crosshair', label: 'Classic crosshair', description: 'The classic crosshair used by some built-in controls.', paths: ['Cursors/CrossMouseIcon.png', 'CrossMouseIcon.png', 'CrossCursor.png', 'Cursors/KeyboardMouse/CrossCursor.png'] },
  { id: 'focus-location', label: 'Focus location', description: 'The cursor marker used by camera focus controls.', paths: ['Cursors/FocusLocation.png'] },
  { id: 'camera-orbit', label: 'Camera orbit', description: 'The icon used by camera orbit controls.', paths: ['Cursors/mouseIconCameraOrbit.png'] },
  { id: 'camera-track', label: 'Camera tracking', description: 'The icon used by camera tracking controls.', paths: ['Cursors/mouseIconCameraTrack.png'] },
  { id: 'camera-zoom', label: 'Camera zoom', description: 'The icon used by camera zoom controls.', paths: ['Cursors/mouseIconCameraZoom.png'] },
  { id: 'gamepad', label: 'Gamepad pointer', description: 'The virtual pointer controlled by a gamepad.', paths: ['Cursors/Gamepad/Pointer.png', 'Cursors/Gamepad/Pointer@2x.png'] },
  { id: 'gamepad-hover', label: 'Gamepad hover', description: 'The gamepad pointer over interactive content.', paths: ['Cursors/Gamepad/PointerOver.png', 'Cursors/Gamepad/PointerOver@2x.png'] },
  { id: 'gamepad-text', label: 'Gamepad text', description: 'The I-beam used for text entry with a gamepad.', paths: ['Cursors/Gamepad/IBeamCursor.png'] },
];

function failure(message, code = 'CURSOR_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function pathId(root) { return hash(process.platform === 'win32' ? root.toLowerCase() : root).slice(0, 24); }
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Validate the complete PNG stream before it can replace any installation file. */
function validatePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.length > MAX_PNG_BYTES || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw failure('Choose a valid PNG file smaller than 8 MB.', 'INVALID_PNG');
  }
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  let ended = false;
  let palette = false;
  const compressed = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw failure('This PNG is incomplete or damaged.', 'INVALID_PNG');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw failure('This PNG is incomplete or damaged.', 'INVALID_PNG');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) {
      throw failure('This PNG failed its integrity check. Try another image.', 'INVALID_PNG');
    }
    if (offset === 8 && type !== 'IHDR') throw failure('This PNG has an invalid header.', 'INVALID_PNG');
    if (type === 'IHDR') {
      if (width !== undefined || length !== 13) throw failure('This PNG has an invalid header.', 'INVALID_PNG');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw failure('Cursor images must be between 1 and 1024 pixels in each dimension.', 'INVALID_PNG');
      }
      if (!validDepths[colorType]?.includes(bitDepth) || data[10] !== 0 || data[11] !== 0 || interlace > 1) {
        throw failure('This PNG uses an unsupported or invalid image format.', 'INVALID_PNG');
      }
    } else if (type === 'PLTE') {
      if (!length || length % 3 !== 0 || length > 768) throw failure('This PNG has an invalid palette.', 'INVALID_PNG');
      palette = true;
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      if (length !== 0 || offset + 12 !== bytes.length) throw failure('This PNG has an invalid ending.', 'INVALID_PNG');
      ended = true;
    } else if (type[0] === type[0].toUpperCase()) {
      throw failure('This PNG contains an unsupported critical chunk.', 'INVALID_PNG');
    }
    offset += length + 12;
  }
  if (!ended || !compressed.length || (colorType === 3 && !palette)) throw failure('This PNG is missing image data.', 'INVALID_PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = [];
  let expectedLength = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = Math.max(0, Math.ceil((width - startX) / stepX));
    const passHeight = Math.max(0, Math.ceil((height - startY) / stepY));
    if (!passWidth || !passHeight) continue;
    const rowBytes = Math.ceil(passWidth * channels * bitDepth / 8);
    for (let row = 0; row < passHeight; row++) rows.push(rowBytes);
    expectedLength += (rowBytes + 1) * passHeight;
  }
  let pixels;
  try { pixels = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedLength + 1 }); }
  catch { throw failure('This PNG cannot be decoded. Try another image.', 'INVALID_PNG'); }
  if (pixels.length !== expectedLength) throw failure('This PNG has damaged pixel data.', 'INVALID_PNG');
  let rowOffset = 0;
  for (const rowBytes of rows) {
    if (pixels[rowOffset] > 4) throw failure('This PNG has invalid pixel filters.', 'INVALID_PNG');
    rowOffset += rowBytes + 1;
  }
  return { width, height };
}

function defaultRoots() {
  const localRoots = new Set([process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local'), process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData', 'Local')].filter(Boolean));
  const roots = [];
  for (const local of localRoots) {
    for (const app of ['Roblox', 'Bloxstrap', 'Fishstrap']) roots.push(path.join(local, app, 'Versions'));
  }
  for (const programFiles of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) roots.push(path.join(programFiles, 'Roblox', 'Versions'));
  return roots;
}

class CursorService {
  constructor({ dataDir, roots, isRobloxRunning = async () => false, inspectPng } = {}) {
    if (!dataDir || typeof dataDir !== 'string') throw new TypeError('A dataDir is required.');
    this.dataDir = path.resolve(dataDir);
    this.roots = roots === undefined ? defaultRoots() : roots.map(root => path.resolve(root));
    this.isRobloxRunning = isRobloxRunning;
    this.inspectPng = inspectPng;
    this.installations = new Map();
    this.staged = new Map();
    this._queue = Promise.resolve();
  }

  async _init() {
    if (!this._initialization) this._initialization = (async () => {
      await fs.mkdir(this.dataDir, { recursive: true });
      if ((await fs.lstat(this.dataDir)).isSymbolicLink()) throw failure('The app data folder cannot be a symbolic link.', 'UNSAFE_PATH');
      this._dataRoot = await realpath(this.dataDir);
      await this._dataPath('backups', true);
      await this._dataPath('staging', true);
    })();
    return this._initialization;
  }

  async _dataPath(relative, directory = false) {
    const target = path.resolve(this._dataRoot, relative);
    if (!within(this._dataRoot, target) || target === this._dataRoot) throw failure('Invalid app data path.', 'UNSAFE_PATH');
    const components = path.relative(this._dataRoot, directory ? target : path.dirname(target)).split(path.sep).filter(Boolean);
    let current = this._dataRoot;
    for (const component of components) {
      current = path.join(current, component);
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !within(this._dataRoot, await realpath(current))) {
        throw failure('The app data folder contains an unsafe link.', 'UNSAFE_PATH');
      }
    }
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || (!directory && !stat.isFile()) || !within(this._dataRoot, await realpath(target))) throw failure('The app data file contains an unsafe link.', 'UNSAFE_PATH');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
  }

  async _atomicWrite(target, bytes, mode) {
    const temporary = path.join(path.dirname(target), `.cursor-${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', ...(mode ? { mode } : {}) });
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async _readJson(relative, fallback) {
    try { return JSON.parse(await fs.readFile(await this._dataPath(relative), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw failure('The saved app data is damaged or inaccessible. Your cursor files have not been changed.', 'DATA_ERROR'); }
  }

  async _writeJson(relative, value) { await this._atomicWrite(await this._dataPath(relative), Buffer.from(JSON.stringify(value, null, 2))); }

  async _installationPath(root, relative, type = 'file') {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw failure('Invalid cursor path.', 'UNSAFE_PATH');
    const target = path.resolve(root, ...relative.split('/'));
    if (!within(root, target)) throw failure('The cursor path escapes the Roblox installation.', 'UNSAFE_PATH');
    let current = root;
    for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      if ((await fs.lstat(current)).isSymbolicLink()) throw failure('Roblox cursor folders cannot contain symbolic links.', 'UNSAFE_PATH');
    }
    const resolved = await realpath(target);
    if (!within(root, resolved)) throw failure('The cursor path escapes the Roblox installation.', 'UNSAFE_PATH');
    const stat = await fs.stat(resolved);
    if ((type === 'file' && !stat.isFile()) || (type === 'directory' && !stat.isDirectory())) throw failure('The Roblox installation contains an invalid cursor path.', 'INVALID_INSTALLATION');
    return resolved;
  }

  async _validateRoot(folder) {
    const absolute = path.resolve(folder);
    if ((await fs.lstat(absolute)).isSymbolicLink()) throw failure('Choose the actual Roblox version folder, rather than a linked folder.', 'UNSAFE_PATH');
    const root = await realpath(absolute);
    if (!(await fs.stat(root)).isDirectory()) throw failure('Choose a Roblox installation folder.', 'INVALID_INSTALLATION');
    await this._installationPath(root, 'RobloxPlayerBeta.exe');
    await this._installationPath(root, 'content/textures', 'directory');
    return root;
  }

  async _manifest(id) {
    const manifest = await this._readJson(`backups/${id}/manifest.json`, { version: 1, files: {} });
    if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw failure('The cursor backup manifest is damaged.', 'DATA_ERROR');
    const allowedPaths = new Set(CURSOR_SLOTS.flatMap(slot => slot.paths.map(relative => `content/textures/${relative}`)));
    for (const [relative, entry] of Object.entries(manifest.files)) {
      if (!allowedPaths.has(relative) || !entry || entry.file !== `${hash(relative)}.png` || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
        throw failure('The cursor backup manifest contains an invalid file.', 'DATA_ERROR');
      }
    }
    return manifest;
  }

  async _readBackup(installationId, entry) {
    let bytes;
    try {
      bytes = await fs.readFile(await this._dataPath(`backups/${installationId}/${entry.file}`));
    } catch (error) {
      if (error.code === 'UNSAFE_PATH') throw error;
      throw failure('A saved original cursor is missing or inaccessible. No cursor files were changed.', 'BACKUP_DAMAGED');
    }
    if (hash(bytes) !== entry.sha256) throw failure('A cursor backup failed its integrity check. No cursor files were changed.', 'BACKUP_DAMAGED');
    return bytes;
  }

  async _describe(root) {
    root = await this._validateRoot(root);
    const id = pathId(root);
    const manifest = await this._manifest(id);
    const cursors = [];
    let writable = true;
    for (const slot of CURSOR_SLOTS) {
      const existing = [];
      const buffers = [];
      for (const relative of slot.paths.map(item => `content/textures/${item}`)) {
        try {
          const target = await this._installationPath(root, relative);
          const stat = await fs.stat(target);
          if (stat.size > MAX_PNG_BYTES) throw failure('An installed cursor is too large to back up safely.', 'INVALID_PNG');
          existing.push(relative);
          buffers.push(await fs.readFile(target));
          try { await fs.access(target, 2); await fs.access(path.dirname(target), 2); }
          catch { writable = false; }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!existing.length) continue;
      let dimensions = { width: 0, height: 0 };
      try { dimensions = validatePng(buffers[0]); } catch { /* Keep damaged installed files visible so an existing backup can be restored. */ }
      cursors.push({
        id: slot.id,
        label: slot.label,
        description: slot.description,
        relativePaths: existing,
        preview: `data:image/png;base64,${buffers[0].toString('base64')}`,
        ...dimensions,
        hasBackup: existing.some(relative => Boolean(manifest.files[relative])),
        modified: existing.some((relative, index) => manifest.files[relative] && manifest.files[relative].sha256 !== hash(buffers[index])),
      });
    }
    const stat = await fs.stat(root);
    const version = path.basename(root);
    const installation = { id, name: /bloxstrap/i.test(root) ? 'Bloxstrap' : /fishstrap/i.test(root) ? 'Fishstrap' : 'Roblox', root, version, modifiedAt: stat.mtime.toISOString(), cursors, writable };
    this.installations.set(id, root);
    return installation;
  }

  async scan() {
    await this._init();
    const custom = await this._readJson('installations.json', []);
    if (!Array.isArray(custom) || custom.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw failure('The saved installation list is damaged.', 'DATA_ERROR');
    const found = new Map();
    const candidates = [...this.roots, ...custom, ...this.installations.values()];
    const visited = new Set();
    const visit = async (folder, depth) => {
      const normalized = path.resolve(folder);
      if (visited.has(normalized)) return;
      visited.add(normalized);
      try {
        const install = await this._describe(normalized);
        found.set(install.id, install);
        return;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'INVALID_INSTALLATION', 'UNSAFE_PATH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      }
      if (depth <= 0) return;
      try {
        if ((await fs.lstat(normalized)).isSymbolicLink()) return;
        for (const entry of await fs.readdir(normalized, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path.join(normalized, entry.name), depth - 1);
        }
      } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    };
    for (const candidate of candidates) await visit(candidate, 2);
    this.installations = new Map([...found.values()].map(install => [install.id, install.root]));
    return [...found.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async addInstallation(folder) {
    if (typeof folder !== 'string' || !folder) throw failure('Choose a Roblox version folder.', 'INVALID_INSTALLATION');
    await this._init();
    let installation;
    try { installation = await this._describe(folder); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'INVALID_INSTALLATION'].includes(error.code)) throw failure('This folder is not a Roblox Player installation. Choose the version folder containing RobloxPlayerBeta.exe and content/textures.', 'INVALID_INSTALLATION');
      throw error;
    }
    const custom = await this._readJson('installations.json', []);
    if (!Array.isArray(custom) || custom.some(root => typeof root !== 'string')) throw failure('The saved installation list is damaged.', 'DATA_ERROR');
    if (!custom.includes(installation.root)) await this._writeJson('installations.json', [...custom, installation.root]);
    return installation;
  }

  async getInstallation(id) {
    await this._init();
    if (typeof id !== 'string' || !this.installations.has(id)) throw failure('Select an installed Roblox version first.', 'INSTALLATION_NOT_FOUND');
    try { return await this._describe(this.installations.get(id)); }
    catch (error) {
      if (error.code === 'ENOENT') throw failure('This Roblox version is no longer installed. Rescan to find the current version.', 'INSTALLATION_NOT_FOUND');
      throw error;
    }
  }

  async stageFile(filePath) {
    await this._init();
    if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.png') throw failure('Drop or choose a .png cursor image.', 'INVALID_PNG');
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_PNG_BYTES) throw failure('Choose a PNG file smaller than 8 MB.', 'INVALID_PNG');
    const bytes = await fs.readFile(filePath);
    const dimensions = validatePng(bytes);
    if (this.inspectPng) {
      const decoded = await this.inspectPng(bytes);
      if (!decoded || decoded.width !== dimensions.width || decoded.height !== dimensions.height) throw failure('This PNG cannot be decoded. Try another image.', 'INVALID_PNG');
    }
    const id = crypto.randomUUID();
    const stagedPath = await this._dataPath(`staging/${id}.png`);
    await this._atomicWrite(stagedPath, bytes);
    this.staged.set(id, { path: stagedPath, sha256: hash(bytes), ...dimensions });
    return { id, name: path.basename(filePath), ...dimensions, preview: `data:image/png;base64,${bytes.toString('base64')}` };
  }

  _exclusive(action) {
    const result = this._queue.then(action);
    this._queue = result.catch(() => {});
    return result;
  }

  async _assertStopped() {
    if (await this.isRobloxRunning()) throw failure('Close Roblox Player before applying or restoring cursors, then try again.', 'ROBLOX_RUNNING');
  }

  async _commit(root, writes) {
    const previous = [];
    for (const write of writes) {
      const target = await this._installationPath(root, write.relative);
      const stat = await fs.stat(target);
      previous.push({ relative: write.relative, bytes: await fs.readFile(target), mode: stat.mode });
    }
    const written = [];
    try {
      for (let index = 0; index < writes.length; index++) {
        const write = writes[index];
        const target = await this._installationPath(root, write.relative);
        await this._atomicWrite(target, write.bytes, previous[index].mode);
        written.push(previous[index]);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const old of written.reverse()) {
        try { await this._atomicWrite(await this._installationPath(root, old.relative), old.bytes, old.mode); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) throw failure('The change failed and some files could not be rolled back. Your original backups are preserved; close Roblox and use Restore originals.', 'ROLLBACK_FAILED');
      throw failure(`The change could not be saved; previous cursor files were restored. ${['EACCES', 'EPERM', 'EBUSY'].includes(error.code) ? 'Close Roblox and check folder permissions.' : error.message}`, 'WRITE_FAILED');
    }
  }

  apply(installationId, changes) {
    return this._exclusive(async () => {
      await this._assertStopped();
      const installation = await this.getInstallation(installationId);
      if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw failure('Add a PNG to at least one cursor before applying.', 'INVALID_CHANGE');
      if (!installation.writable) throw failure('This Roblox folder is read-only. Choose a writable installation or run with the folder permissions needed to change it.', 'READ_ONLY');
      const manifest = await this._manifest(installation.id);
      const writes = [];
      for (const [slotId, imageId] of Object.entries(changes)) {
        const slot = installation.cursors.find(cursor => cursor.id === slotId);
        if (!slot) throw failure('That cursor is not available in the selected Roblox installation.', 'INVALID_SLOT');
        const staged = this.staged.get(imageId);
        if (!staged) throw failure('This staged image is no longer available. Drop the PNG again.', 'STAGED_IMAGE_NOT_FOUND');
        const bytes = await fs.readFile(await this._dataPath(`staging/${imageId}.png`));
        validatePng(bytes);
        if (hash(bytes) !== staged.sha256) throw failure('The staged PNG has changed. Drop the original PNG again.', 'INVALID_PNG');
        for (const relative of slot.relativePaths) writes.push({ relative, bytes });
      }
      // Verify all existing originals before saving new backups or changing any installation file.
      for (const write of writes) {
        const entry = manifest.files[write.relative];
        if (entry) await this._readBackup(installation.id, entry);
      }
      // Capture and persist every original before touching any cursor. Existing backups are immutable.
      for (const write of writes) {
        if (manifest.files[write.relative]) continue;
        const target = await this._installationPath(installation.root, write.relative);
        const original = await fs.readFile(target);
        const filename = `${hash(write.relative)}.png`;
        const backup = await this._dataPath(`backups/${installation.id}/${filename}`);
        try { await fs.writeFile(backup, original, { flag: 'wx' }); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (hash(await fs.readFile(backup)) !== hash(original)) throw failure('An unrecorded backup already exists for this cursor. Your files have not been changed.', 'BACKUP_CONFLICT');
        }
        manifest.files[write.relative] = { file: filename, sha256: hash(original) };
      }
      await this._writeJson(`backups/${installation.id}/manifest.json`, manifest);
      await this._assertStopped();
      await this._commit(installation.root, writes);
      return this.getInstallation(installationId);
    });
  }

  restore(installationId, slotId) {
    return this._exclusive(async () => {
      await this._assertStopped();
      const installation = await this.getInstallation(installationId);
      if (slotId !== undefined && !installation.cursors.some(cursor => cursor.id === slotId)) throw failure('That cursor is not available in this installation.', 'INVALID_SLOT');
      if (!installation.writable) throw failure('This Roblox folder is read-only. Check folder permissions before restoring cursors.', 'READ_ONLY');
      const manifest = await this._manifest(installation.id);
      const selected = slotId === undefined ? installation.cursors : installation.cursors.filter(cursor => cursor.id === slotId);
      const writes = [];
      for (const cursor of selected) {
        for (const relative of cursor.relativePaths) {
          const entry = manifest.files[relative];
          if (!entry) continue;
          const bytes = await this._readBackup(installation.id, entry);
          writes.push({ relative, bytes });
        }
      }
      if (!writes.length) throw failure('There are no saved originals to restore for this selection.', 'NO_BACKUP');
      await this._assertStopped();
      await this._commit(installation.root, writes);
      return this.getInstallation(installationId);
    });
  }
}

module.exports = { CursorService, CURSOR_SLOTS, validatePng, defaultRoots };
