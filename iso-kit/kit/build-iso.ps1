# NexusOS ISO builder (Windows side): checks WSL, then runs kit/build.sh inside Debian as root.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Step($t) { Write-Host ""; Write-Host "  $t" -ForegroundColor Cyan }
function Bad($t)  { Write-Host ""; Write-Host "  $t" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  NEXUSOS ISO BUILDER" -ForegroundColor Magenta
Write-Host "  Builds NexusOS-1.4-amd64.iso into your Downloads folder. Takes 30-90 minutes."

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  Bad "WSL isn't available on this PC. Open PowerShell as administrator, run:  wsl --install -d Debian  then restart and run this again."
}
$env:WSL_UTF8 = '1'
function WslList { ((& wsl.exe --list --verbose 2>&1) | Out-String) -replace "`0", '' }
$list = WslList
if ($list -notmatch '(?m)^\s*\*?\s*Debian\s') {
  Write-Host ""
  Write-Host "  Debian for WSL isn't installed yet. One-time setup:" -ForegroundColor Yellow
  Write-Host "   1. Open PowerShell as administrator and run:   wsl --install -d Debian"
  Write-Host "   2. Restart if it asks. Debian opens and asks for a username and password: pick any."
  Write-Host "   3. Run BUILD-NexusOS-ISO.bat again."
  exit 1
}
if ($list -match '(?m)^\s*\*?\s*Debian\s+\S+\s+1\s*$') {
  Step "Switching Debian to WSL 2 (needed to build an OS)..."
  & wsl.exe --set-version Debian 2
  if ($LASTEXITCODE -ne 0) { Bad "Couldn't switch Debian to WSL 2. Run  wsl --update  as administrator, then try again." }
}

# where the ISO goes: your Downloads folder
$out = $null
try { $out = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path } catch {}
if (-not $out -or -not (Test-Path $out)) { $out = Join-Path $env:USERPROFILE 'Downloads' }
[IO.File]::WriteAllText((Join-Path $here 'out-dir.txt'), $out)   # UTF-8, no BOM
Write-Host "  The ISO will be saved in: $out"

# keep the PC awake while it builds
try {
  Add-Type -Namespace NX -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
  [NX.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null
} catch {}

Step "Starting the build inside WSL (Debian)... Keep this window open and the laptop plugged in."
& wsl.exe -d Debian -u root --cd $here -- bash -c "tr -d '\r' < build.sh > /tmp/nexusos-build.sh && exec bash /tmp/nexusos-build.sh"
$code = $LASTEXITCODE
try { [NX.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null } catch {}
if ($code -ne 0) {
  Bad "The build stopped (code $code). The full log is in your Downloads folder as NexusOS-build-log.txt. Send me the last 50 lines and I'll sort it."
}
Write-Host ""
Write-Host "  All done. Next: put NexusOS-1.4-amd64.iso on a USB stick with Rufus or balenaEtcher (see README)." -ForegroundColor Green
