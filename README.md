# Cursor Studio

Replace the built-in cursors in your Roblox Player installation with your own PNGs. Drag and drop, preview, apply, and restore the originals whenever you want.

## Download for Windows

**[Download Cursor Studio (.exe)](https://github.com/kodabkr/CursorManager/releases/latest/download/Cursor-Studio-1.0.0-Windows.exe)**

The portable app runs on Windows 10/11 (64-bit). Download it and double-click it—no installer, Node.js, or Git needed. You can also find the executable on the [latest release page](https://github.com/kodabkr/CursorManager/releases/latest).

## Use it

1. Close Roblox Player and open Cursor Studio.
2. Check the selected installation. The app automatically picks the valid Player version folder with the newest **Windows Date modified** timestamp. You can choose another installation or browse to one.
3. Drag a `.png` onto a cursor card, such as **Normal pointer**, **Hover pointer**, **Drag pressed**, or **Shift-lock**. Click **Open sample cursors** for included PNGs to try.
4. Click **Apply changes**, then reopen Roblox.

Original cursors are backed up automatically. Open **Backups** to restore individual cursors or all originals, with Roblox closed.

Use transparent PNGs near the original cursor's size; files can be up to 8 MB and 1024 × 1024 pixels. The app shows the cursor types available in your installation. Games using their own cursor images can override Roblox's built-in cursors.

After a Roblox update, click **Rescan** and apply your PNGs to the newest installation again.

## Build from source

On Windows, install [Node.js](https://nodejs.org/) **22.12 or newer** and [Git](https://git-scm.com/), then open PowerShell:

```powershell
git clone https://github.com/kodabkr/CursorManager.git
cd CursorManager
npm ci
npm start
```

To create the portable executable:

```powershell
npm run build
```

Your executable will be in `release/Cursor-Studio-1.0.0-Windows.exe`.

## Sample cursors and license

The included test PNGs are from Kenney's public-domain (CC0) [Cursor Pack](https://kenney.nl/assets/cursor-pack) and [Crosshair Pack](https://kenney.nl/assets/crosshair-pack). See [sample sources](assets/test-cursors/SOURCES.md) for details.

Cursor Studio's source code is licensed under [MIT](LICENSE).
