param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\assets\test-cursors'),
    [switch]$CopyToDownloads
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

$packs = @(
    @{
        Url = 'https://kenney.nl/media/pages/assets/cursor-pack/461b29df18-1717599281/kenney_cursor-pack.zip'
        LicenseName = 'KENNEY-CURSOR-LICENSE.txt'
        Files = @{
            'PNG/Outline/Default/pointer_a.png' = '01-normal-arrow.png'
            'PNG/Outline/Default/hand_point.png' = '02-hover-hand.png'
            'PNG/Outline/Default/hand_closed.png' = '03-pressed-hand.png'
        }
    },
    @{
        Url = 'https://kenney.nl/media/pages/assets/crosshair-pack/5ef74bd405-1785950072/kenney_crosshair-pack.zip'
        LicenseName = 'KENNEY-CROSSHAIR-LICENSE.txt'
        Files = @{
            'PNG/Outline/crosshair-006.png' = '04-shift-lock-ring.png'
            'PNG/Outline/crosshair-020.png' = '05-crosshair-plus.png'
        }
    }
)

foreach ($pack in $packs) {
    $archivePath = Join-Path ([System.IO.Path]::GetTempPath()) ('roblox-cursor-samples-' + [guid]::NewGuid().ToString('N') + '.zip')
    $archive = $null
    try {
        Invoke-WebRequest -Uri $pack.Url -OutFile $archivePath -UseBasicParsing
        $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
        foreach ($source in $pack.Files.Keys) {
            $entry = $archive.GetEntry($source)
            if (-not $entry) { throw "Downloaded pack is missing $source" }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $OutputDirectory $pack.Files[$source]), $true)
        }
        $license = $archive.GetEntry('License.txt')
        if (-not $license) { throw 'Downloaded pack is missing License.txt' }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($license, (Join-Path $OutputDirectory $pack.LicenseName), $true)
    }
    finally {
        if ($archive) { $archive.Dispose() }
        if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    }
}

if ($CopyToDownloads) {
    $downloads = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\Roblox Cursor Samples'
    New-Item -ItemType Directory -Force -Path $downloads | Out-Null
    Get-ChildItem -LiteralPath $OutputDirectory -File | Copy-Item -Destination $downloads -Force
    Write-Output "Samples copied to $downloads"
}

Write-Output "Five transparent PNG samples are ready in $OutputDirectory"
