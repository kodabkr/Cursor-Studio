'use strict';

const api = window.cursorStudio;
const $ = (id) => document.getElementById(id);
const state = {
  installations: [],
  selectedId: null,
  stages: new Map(),
  view: 'cursors',
  busy: '',
  running: false,
  manuallySelected: false,
  scanError: '',
  hovering: false,
  pressed: false,
  cursorImages: new Map(),
};

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  svg.append(use);
  return svg;
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function selectedInstallation() {
  return state.installations.find((installation) => installation.id === state.selectedId);
}

function pendingChanges(id = state.selectedId) {
  return state.stages.get(id) || {};
}

function errorMessage(error) {
  return typeof error?.message === 'string' ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Something went wrong. Please try again.';
}

function toast(message, isError = false) {
  const notification = element('div', `toast${isError ? ' error' : ''}`);
  notification.setAttribute('role', isError ? 'alert' : 'status');
  notification.append(icon(isError ? 'info' : 'check'), element('span', '', message));
  const close = element('button', 'toast-close');
  close.setAttribute('aria-label', 'Dismiss notification');
  close.append(icon('close'));
  const remove = () => {
    notification.classList.add('leaving');
    window.setTimeout(() => notification.remove(), 220);
  };
  close.addEventListener('click', remove);
  notification.append(close);
  $('toast-region').append(notification);
  window.setTimeout(remove, isError ? 8500 : 5500);
}

function canUseApi() {
  if (api) return true;
  toast('Open Cursor Studio through Electron to use installation tools.', true);
  return false;
}

function friendlyDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function imageSource(preview) {
  return typeof preview === 'string' && /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(preview) ? preview : '';
}

function previewImage(preview, label, className = 'cursor-image') {
  const source = imageSource(preview);
  if (!source) {
    const placeholder = element('span', 'image-placeholder');
    placeholder.append(icon('image'));
    placeholder.setAttribute('aria-label', 'Image preview unavailable');
    return placeholder;
  }
  const image = element('img', className);
  image.src = source;
  image.alt = label;
  image.draggable = false;
  return image;
}

function previewColumn(preview, label, isNew = false) {
  const column = element('div', 'preview-column');
  column.append(previewImage(preview, `${isNew ? 'Staged' : 'Installed'} cursor`), element('span', `preview-label${isNew ? ' new' : ''}`, label));
  return column;
}

function setBusy(busy) {
  state.busy = busy;
  render();
}

function updateInstallation(installation) {
  const index = state.installations.findIndex((item) => item.id === installation.id);
  if (index < 0) state.installations.push(installation);
  else state.installations[index] = installation;
}

function renderInstallation() {
  const selected = selectedInstallation();
  const select = $('installation-select');
  select.replaceChildren();
  if (state.installations.length) {
    state.installations.forEach((installation, index) => {
      const option = element('option', '', `${installation.name || 'Roblox Player'}${installation.version ? ` · ${installation.version}` : ''}${index === 0 ? ' · Most recently modified' : ''}`);
      option.value = installation.id;
      option.title = `${installation.root}\nModified ${friendlyDate(installation.modifiedAt)}`;
      select.append(option);
    });
    select.value = state.selectedId;
  } else {
    const option = element('option', '', state.busy === 'scan' ? 'Looking for Roblox…' : 'No installation selected');
    option.value = '';
    select.append(option);
  }
  select.disabled = !state.installations.length || !!state.busy;
  $('installation-path').textContent = selected?.root || (state.busy === 'scan' ? 'Checking your local installation folders' : 'Browse to a Roblox version folder to get started');
  $('installation-path').title = selected?.root || '';
  $('installation-date').hidden = !selected;
  $('installation-date').textContent = selected ? `${state.installations[0]?.id === selected.id ? 'Most recently modified · ' : ''}Folder modified ${friendlyDate(selected.modifiedAt)}` : '';
  const status = $('installation-status');
  status.className = 'installation-status';
  if (state.busy === 'scan') status.textContent = 'SCANNING';
  else if (!selected) { status.textContent = 'NOT FOUND'; status.classList.add('unavailable'); }
  else if (selected.writable === false) { status.textContent = 'READ ONLY'; status.classList.add('readonly'); }
  else status.textContent = state.installations[0]?.id === selected.id ? 'LATEST' : 'READY';
  $('scan-button').disabled = !!state.busy || !api;
  $('scan-button').classList.toggle('loading', state.busy === 'scan');
  $('browse-button').disabled = !!state.busy || !api;
  $('empty-scan').disabled = !!state.busy || !api;
  $('empty-browse').disabled = !!state.busy || !api;
  $('running-note').hidden = !state.running;
}

function createCursorCard(cursor, installation, staged) {
  const card = element('article', `cursor-card${staged ? ' staged' : ''}`);
  card.dataset.slot = cursor.id;
  card.tabIndex = 0;
  card.setAttribute('aria-label', `${cursor.label}. Drop a PNG or press Enter to replace.`);
  const title = element('div', 'card-title');
  title.append(element('h3', '', cursor.label));
  if (staged) title.append(element('span', 'card-badge staged', 'STAGED'));
  else if (cursor.modified) title.append(element('span', 'card-badge modified', 'CUSTOM'));
  else title.append(element('span', 'card-badge', 'ORIGINAL'));
  const description = element('p', 'card-description', cursor.description || 'Replace this Roblox cursor image.');
  const preview = element('div', 'card-preview');
  preview.append(previewColumn(cursor.preview, staged ? 'INSTALLED' : 'CURRENT CURSOR'));
  if (staged) preview.append(previewColumn(staged.preview, 'YOUR REPLACEMENT', true));
  const overlay = element('div', 'drop-overlay');
  overlay.append(icon('upload'), element('span', '', 'Drop your PNG here'));
  preview.append(overlay);
  const meta = element('div', 'card-meta');
  const paths = Array.isArray(cursor.relativePaths) ? cursor.relativePaths : [];
  const filename = staged?.name || paths[0]?.split(/[\\/]/).pop() || 'PNG image';
  const file = element('span', 'card-file', filename);
  file.title = staged?.name || paths.join('\n');
  const width = staged?.width || cursor.width;
  const height = staged?.height || cursor.height;
  meta.append(file, element('span', 'card-dimensions', width && height ? `${width} × ${height}` : 'PNG'));
  const actions = element('div', 'card-actions');
  const replace = element('button', 'button replace-button');
  replace.append(icon('upload'), element('span', '', staged ? 'Choose another PNG' : 'Replace PNG'));
  replace.disabled = !!state.busy || !api || installation.writable === false;
  replace.addEventListener('click', () => chooseForSlot(cursor.id));
  actions.append(replace);
  if (staged) {
    const undo = element('button', 'button card-undo');
    undo.title = 'Discard this replacement';
    undo.setAttribute('aria-label', `Discard replacement for ${cursor.label}`);
    undo.append(icon('close'));
    undo.disabled = !!state.busy;
    undo.addEventListener('click', () => discardSlot(cursor.id));
    actions.append(undo);
  } else if (cursor.hasBackup) {
    const restore = element('button', 'button card-restore');
    restore.title = 'Restore original';
    restore.setAttribute('aria-label', `Restore original ${cursor.label}`);
    restore.append(icon('history'));
    restore.disabled = !!state.busy || state.running || installation.writable === false;
    restore.addEventListener('click', () => restoreOriginal(cursor.id));
    actions.append(restore);
  }
  card.append(title, description, preview, meta);
  if (staged && cursor.width && cursor.height && (staged.width !== cursor.width || staged.height !== cursor.height)) {
    const sizeHint = element('p', 'size-mismatch');
    const sizeHintText = element('span', '', `Size differs · installed is ${cursor.width} × ${cursor.height}`);
    sizeHintText.append(element('span', 'size-mismatch-note', 'PNG size is kept; Roblox sets the hotspot.'));
    sizeHint.title = 'Your PNG keeps its original dimensions. Roblox determines the cursor hotspot, so a different image size may change the alignment.';
    sizeHint.append(sizeHintText, icon('info'));
    card.append(sizeHint);
  }
  card.append(actions);
  let dragDepth = 0;
  card.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (state.busy || !api || installation.writable === false) return;
    dragDepth += 1;
    card.classList.add('drag-over');
  });
  card.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = state.busy || installation.writable === false ? 'none' : 'copy';
  });
  card.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) card.classList.remove('drag-over');
  });
  card.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    card.classList.remove('drag-over');
    if (state.busy || !api || installation.writable === false) return;
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length !== 1 || !/\.png$/i.test(files[0].name)) {
      toast('Drop one .png file onto the cursor you want to replace.', true);
      return;
    }
    await stageForSlot(cursor.id, () => api.stageFile(files[0]));
  });
  card.addEventListener('keydown', (event) => {
    if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!replace.disabled) chooseForSlot(cursor.id);
  });
  return card;
}

function renderCursors() {
  const installation = selectedInstallation();
  const cursors = installation?.cursors || [];
  $('cursor-count').textContent = cursors.length;
  $('nav-count').textContent = cursors.length;
  $('cursor-grid').replaceChildren(...cursors.map((cursor) => createCursorCard(cursor, installation, pendingChanges()[cursor.id])));
  const empty = !installation || !cursors.length;
  $('empty-state').hidden = !empty;
  $('playground').hidden = empty;
  $('content-note').hidden = empty;
  if (state.busy === 'scan' && !installation) {
    $('empty-title').textContent = 'Finding your Roblox installation…';
    $('empty-description').textContent = 'Checking local folders for available cursor images.';
  } else if (installation && !cursors.length) {
    $('empty-title').textContent = 'No supported cursors in this folder.';
    $('empty-description').textContent = 'Try another Roblox Player version folder. Cursor Studio shows the supported image files that actually exist in your installation.';
  } else {
    $('empty-title').textContent = 'Let’s find your Roblox.';
    $('empty-description').textContent = state.scanError || 'We couldn’t find an installation automatically. Browse to your Roblox folder, or install and run Roblox once, then scan again.';
  }
  updatePlayground();
}

function renderBackups() {
  const installation = selectedInstallation();
  const backups = (installation?.cursors || []).filter((cursor) => cursor.hasBackup);
  $('backup-count').textContent = backups.length;
  $('backup-empty').hidden = !!backups.length;
  $('backup-list').replaceChildren(...backups.map((cursor) => {
    const row = element('article', 'backup-row');
    const image = element('div', 'backup-image');
    if (cursor.backupPreview) image.append(previewImage(cursor.backupPreview, `${cursor.label} original backup`));
    else image.append(icon('shield'));
    const detail = element('div', 'backup-row-detail');
    const imageCount = Array.isArray(cursor.relativePaths) ? cursor.relativePaths.length : 1;
    detail.append(element('h3', '', cursor.label), element('p', '', `${imageCount} original image${imageCount === 1 ? '' : 's'} saved · ${cursor.modified ? 'Custom cursor installed' : 'Original cursor installed'}`));
    const restore = element('button', 'button button-secondary');
    restore.append(icon('history'), element('span', '', 'Restore original'));
    restore.disabled = !!state.busy || state.running || installation.writable === false;
    restore.addEventListener('click', () => restoreOriginal(cursor.id));
    row.append(image, detail, restore);
    return row;
  }));
  $('restore-all').hidden = !backups.length;
  $('restore-all').disabled = !!state.busy || state.running || installation?.writable === false;
  $('open-backups').disabled = !api;
}

function renderFooter() {
  const installation = selectedInstallation();
  const count = Object.keys(pendingChanges()).length;
  $('apply-status-icon').classList.toggle('pending', count > 0);
  $('apply-status-icon').replaceChildren(icon(count ? 'upload' : 'check'));
  $('apply-status-title').textContent = state.busy === 'apply' ? 'Updating your cursor files…' : count ? `${count} cursor change${count === 1 ? '' : 's'} ready` : 'Everything is up to date';
  $('apply-status-description').textContent = count ? 'Originals are backed up before applying.' : 'Choose a PNG to start making it yours.';
  $('discard-button').hidden = !count;
  $('discard-button').disabled = !!state.busy;
  $('apply-button').disabled = !count || !!state.busy || state.running || !api || installation?.writable === false;
  $('apply-button').querySelector('span').textContent = state.busy === 'apply' ? 'Applying…' : count ? `Apply ${count} change${count === 1 ? '' : 's'}` : 'Apply changes';
  $('apply-button').title = state.running ? 'Close Roblox before applying cursor changes.' : installation?.writable === false ? 'This installation folder is read only.' : '';
}

function render() {
  renderInstallation();
  renderCursors();
  renderBackups();
  renderFooter();
  $('cursors-view').hidden = state.view !== 'cursors';
  $('backups-view').hidden = state.view !== 'backups';
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === state.view);
    if (item.dataset.view === state.view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  $('page-title').textContent = state.view === 'cursors' ? 'Your game. Your cursor.' : 'A fresh start, anytime.';
  $('page-subtitle').textContent = state.view === 'cursors' ? 'Give the little things a personal touch.' : 'Bring back the originals with a single click.';
}

async function scan() {
  if (!canUseApi() || state.busy) return;
  setBusy('scan');
  try {
    const result = await api.scan();
    state.installations = Array.isArray(result.installations) ? result.installations : [];
    state.running = Array.isArray(result.running) ? result.running.length > 0 : !!result.running;
    state.scanError = '';
    const stillValid = state.installations.some((item) => item.id === state.selectedId);
    if (!stillValid || (!state.manuallySelected && !Object.keys(pendingChanges()).length)) {
      state.selectedId = state.installations[0]?.id || null;
    }
  } catch (error) {
    state.scanError = errorMessage(error);
    toast(state.scanError, true);
  } finally { setBusy(''); }
}

async function browse() {
  if (!canUseApi() || state.busy) return;
  setBusy('browse');
  try {
    const installation = await api.addInstallation();
    if (!installation) return;
    updateInstallation(installation);
    state.installations.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
    state.selectedId = installation.id;
    state.manuallySelected = true;
    state.scanError = '';
    toast('Roblox installation added. Choose a cursor to customize.');
  } catch (error) { toast(errorMessage(error), true); }
  finally { setBusy(''); }
}

async function stageForSlot(slotId, getAsset) {
  if (state.busy) return;
  const installationId = state.selectedId;
  setBusy('stage');
  try {
    const asset = await getAsset();
    if (!asset) return;
    if (!asset.id || !imageSource(asset.preview)) throw new Error('This PNG could not be loaded. Try another image.');
    const changes = { ...pendingChanges(installationId), [slotId]: asset };
    state.stages.set(installationId, changes);
    toast(`${asset.name || 'PNG'} is ready. Apply your changes when you’re happy with the preview.`);
  } catch (error) { toast(errorMessage(error), true); }
  finally { setBusy(''); }
}

async function chooseForSlot(slotId) {
  if (!canUseApi()) return;
  await stageForSlot(slotId, () => api.choosePng());
}

function discardSlot(slotId) {
  const changes = { ...pendingChanges() };
  delete changes[slotId];
  state.stages.set(state.selectedId, changes);
  render();
}

async function applyChanges() {
  if (!canUseApi() || state.busy) return;
  const installationId = state.selectedId;
  const entries = Object.entries(pendingChanges());
  if (!entries.length) return;
  setBusy('apply');
  try {
    const installation = await api.apply({ installationId, changes: Object.fromEntries(entries.map(([slotId, asset]) => [slotId, asset.id])) });
    updateInstallation(installation);
    state.stages.delete(installationId);
    toast(`${entries.length} cursor${entries.length === 1 ? '' : 's'} updated. Reopen Roblox to see your changes.`);
  } catch (error) { toast(errorMessage(error), true); }
  finally { setBusy(''); }
}

function confirmRestore(cursor) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = cursor ? `Restore ${cursor.label}?` : 'Restore all original cursors?';
  $('confirm-description').textContent = cursor ? 'The saved original image will replace this installed cursor. Any staged replacement for this cursor will be discarded.' : 'Saved original images will replace the customized cursors in this installation. Staged replacements for restored cursors will be discarded.';
  $('confirm-accept').textContent = cursor ? 'Restore original' : 'Restore all originals';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.returnValue = '';
    dialog.showModal();
  });
}

async function restoreOriginal(slotId) {
  if (!canUseApi() || state.busy) return;
  const installation = selectedInstallation();
  if (!installation) return;
  const cursor = slotId ? installation.cursors.find((item) => item.id === slotId) : null;
  if (!(await confirmRestore(cursor))) return;
  setBusy('restore');
  try {
    const result = await api.restore({ installationId: installation.id, ...(slotId ? { slotId } : {}) });
    updateInstallation(result);
    const staged = { ...pendingChanges(installation.id) };
    for (const item of installation.cursors) if (item.hasBackup && (!slotId || item.id === slotId)) delete staged[item.id];
    state.stages.set(installation.id, staged);
    toast(slotId ? `${cursor.label} restored to the original. Reopen Roblox to see it.` : 'Your original cursors are restored. Reopen Roblox to see them.');
  } catch (error) { toast(errorMessage(error), true); }
  finally { setBusy(''); }
}

function cursorForRole(role) {
  const cursors = selectedInstallation()?.cursors || [];
  const ids = { normal: 'normal', hover: 'hover', locked: 'shift-lock', pressed: 'drag-pressed' };
  const exact = cursors.find((cursor) => cursor.id === ids[role]);
  if (exact) return exact;
  const text = (cursor) => `${cursor.id} ${cursor.label} ${cursor.relativePaths?.join(' ') || ''}`.toLowerCase();
  if (role === 'locked') return cursors.find((cursor) => /shift.lock|mouselockedcursor\.png/.test(text(cursor)));
  if (role === 'pressed') return cursors.find((cursor) => /drag.pressed|activatedcursor\.png/.test(text(cursor)));
  if (role === 'hover') return cursors.find((cursor) => /arrowcursor\.png|hover pointer/.test(text(cursor)) && !/drag|gamepad/.test(text(cursor)));
  return cursors.find((cursor) => /normal|default|arrowfarcursor\.png/.test(text(cursor)) && !/drag|gamepad|shift|locked/.test(text(cursor)));
}

function makeCssCursor(preview) {
  const source = imageSource(preview);
  if (!source) return Promise.resolve('');
  if (state.cursorImages.has(source)) return state.cursorImages.get(source);
  const promise = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const size = 48;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight, 1);
        const width = Math.round(img.naturalWidth * scale);
        const height = Math.round(img.naturalHeight * scale);
        const x = Math.floor((size - width) / 2);
        const y = Math.floor((size - height) / 2);
        ctx.drawImage(img, x, y, width, height);
        resolve(`url("${canvas.toDataURL('image/png')}") ${Math.floor(size / 2)} ${Math.floor(size / 2)}`);
      } catch { resolve(''); }
    };
    img.onerror = () => resolve('');
    img.src = source;
  });
  state.cursorImages.set(source, promise);
  return promise;
}

async function updatePlayground() {
  const installationId = state.selectedId;
  const roles = ['normal', 'hover', 'locked', 'pressed'];
  const previews = roles.map((role) => {
    const cursor = cursorForRole(role) || (role === 'pressed' ? cursorForRole('hover') || cursorForRole('normal') : undefined);
    return pendingChanges()[cursor?.id]?.preview || cursor?.preview;
  });
  const results = await Promise.all(previews.map(makeCssCursor));
  if (state.selectedId !== installationId) return;
  const area = $('playground-area');
  for (let index = 0; index < results.length; index += 1) {
    const role = roles[index];
    const fallback = ['default', 'pointer', 'crosshair', 'pointer'][index];
    area.style.setProperty(`--${role}-cursor`, results[index] ? `${results[index]}, ${fallback}` : fallback);
  }
  const locked = $('shift-toggle').checked;
  area.classList.toggle('shift-locked', locked);
  area.classList.toggle('pressed', state.pressed);
  const pressedLabel = cursorForRole('pressed') ? 'Drag pressed preview' : cursorForRole('hover') ? 'Click held · hover preview' : 'Click held · normal preview';
  $('preview-mode-label').textContent = locked ? 'Shift lock preview' : state.pressed ? pressedLabel : state.hovering ? 'Hover cursor' : 'Normal cursor';
}

async function openFolder(method) {
  if (!canUseApi()) return;
  try { await api[method](); }
  catch (error) { toast(errorMessage(error), true); }
}

$('scan-button').addEventListener('click', scan);
$('empty-scan').addEventListener('click', scan);
$('browse-button').addEventListener('click', browse);
$('empty-browse').addEventListener('click', browse);
$('installation-select').addEventListener('change', (event) => {
  state.selectedId = event.target.value;
  state.manuallySelected = true;
  render();
});
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => {
  state.view = button.dataset.view;
  render();
  $('content-scroll').scrollTop = 0;
}));
$('apply-button').addEventListener('click', applyChanges);
$('discard-button').addEventListener('click', () => { state.stages.delete(state.selectedId); render(); });
$('restore-all').addEventListener('click', () => restoreOriginal());
$('open-backups').addEventListener('click', () => openFolder('openBackups'));
$('open-samples').addEventListener('click', () => openFolder('openSamples'));
$('shift-toggle').addEventListener('change', updatePlayground);
document.querySelectorAll('.preview-target').forEach((button) => {
  button.addEventListener('mouseenter', () => { state.hovering = true; updatePlayground(); });
  button.addEventListener('mouseleave', () => { state.hovering = false; state.pressed = false; updatePlayground(); });
  button.addEventListener('pointerdown', () => { state.pressed = true; updatePlayground(); });
  button.addEventListener('pointerup', () => { state.pressed = false; updatePlayground(); });
  button.addEventListener('click', (event) => event.preventDefault());
});
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());

async function initialize() {
  $('preview-note').hidden = !!api;
  render();
  if (!api) return;
  try {
    const info = await api.getAppInfo();
    $('app-version').textContent = `v${info.version}`;
    $('open-samples').title = info.samplesPath || 'Open sample cursor folder';
  } catch { /* Installation discovery remains available if app metadata fails. */ }
  await scan();
}

initialize();
