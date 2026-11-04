# Windows smoke test (CI runs it on windows-latest under Windows PowerShell 5.1): starts a throwaway server, installs pb
# with /install.ps1, and drives it from PowerShell, cmd and Git Bash.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Work = Join-Path ([IO.Path]::GetTempPath()) "pb-smoke-$PID"
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$Port = 4797
$Base = "http://127.0.0.1:$Port"
$env:PB_AUTH = 'off'; $env:PB_HOST = '127.0.0.1'; $env:PB_PORT = "$Port"; $env:PB_DATA = "$Work\data"; $env:PB_PUBLIC_URL = $Base
$env:XDG_CONFIG_HOME = "$Work\config"
$env:PB_INSTALL_DIR = "$Work\Program Files\pb"   # a space in the path, as user folders often have
$env:PB_NO_PATH = '1'                            # leave the runner's PATH alone; the installer still adds it here
$server = Start-Process node -ArgumentList "`"$Root\server.js`"" -PassThru -NoNewWindow -RedirectStandardOutput "$Work\server.log" -RedirectStandardError "$Work\server.err"

# Runs the block; it fails on an error, a non-zero exit code, or a block that returns $false. Returns what it printed.
function Check([string]$what, [scriptblock]$block) {
	$ErrorActionPreference = 'Continue'   # pb's notices on stderr are not failures
	$global:LASTEXITCODE = 0
	$failed = $false
	try {
		$result = @(& $block 2>&1)
	} catch {
		$result = @($_)
		$failed = $true
	}
	$out = ($result | ForEach-Object { "$_" }) -join "`n"
	if ($failed -or $LASTEXITCODE -ne 0 -or ($result.Count -eq 1 -and $result[0] -is [bool] -and -not $result[0])) {
		Write-Host "FAIL $what (exit code $LASTEXITCODE)`n$out"
		throw $what
	}
	Write-Host "ok   $what"
	return $out
}
function Has([string]$what, [string]$out, [string]$text) {
	if (-not $out.Contains($text)) { Write-Host "FAIL ${what}: no `"$text`" in:`n$out"; throw $what }
	Write-Host "ok   $what"
}

try {
	for ($i = 0; ; $i++) {
		try { Invoke-RestMethod -UseBasicParsing "$Base/api/health" | Out-Null; break } catch { if ($i -gt 50) { Get-Content "$Work\server.err"; throw 'server did not start' }; Start-Sleep -Milliseconds 200 }
	}
	Check 'install' { Invoke-RestMethod -UseBasicParsing "$Base/install.ps1" | Invoke-Expression } | Out-Null
	$dir = $env:PB_INSTALL_DIR
	Check 'pb and pb.cmd are there' { (Test-Path "$dir\pb") -and (Test-Path "$dir\pb.cmd") } | Out-Null
	Check 'the folder is on PATH for this session' { ($env:Path -split ';') -contains $dir } | Out-Null
	$out = Check 'pb version from PowerShell' { pb version --local }
	Has 'it is this version' $out (Select-String -Path "$Root\bin\pb" -Pattern "^const VERSION = '(.*)';$").Matches[0].Groups[1].Value
	Check 'pb version from cmd' { cmd /c "pb version --local" } | Out-Null
	# Git Bash runs the pb file itself, by its #! line. Commands go through a file: Windows PowerShell mangles double
	# quotes in arguments to programs.
	$bash = 'C:\Program Files\Git\bin\bash.exe'
	$bashDir = ($dir -replace '\\', '/')
	function BashRun([string]$command) {
		[IO.File]::WriteAllText("$Work\run.sh", "$command`n")
		& $bash ("$Work\run.sh" -replace '\\', '/')
	}
	Check 'pb version from Git Bash' { BashRun "`"$bashDir/pb`" version --local" } | Out-Null

	$repo = "$Work\repo"
	New-Item -ItemType Directory -Force -Path "$repo\sub" | Out-Null
	Set-Location $repo
	Check 'register' { pb register demo --name Demo --path $repo } | Out-Null
	Check 'add a task' { pb add --title 'first & second' } | Out-Null
	Check 'pb use' { pb use $Base --project demo } | Out-Null
	Set-Location "$repo\sub"
	Has 'tasks from a subfolder' (Check 'tasks' { pb tasks }) 'first & second'
	# The project found by its folder, whatever the case of the path.
	Remove-Item "$repo\.project-boards.json"
	Set-Location ("$repo\sub".ToUpperInvariant())
	Has 'project found by folder, ignoring case' (Check 'tasks by folder' { pb tasks }) 'first & second'

	Set-Location $repo
	Check 'hook install' { pb hook install } | Out-Null
	$settings = Get-Content -Raw "$repo\.claude\settings.local.json" | ConvertFrom-Json
	$command = $settings.hooks.Stop[0].hooks[0].command
	Check 'the hook runs pb with node, by a forward-slash path' { $command -match '^node "[A-Za-z]:/[^\\"]*/pb" hook$' } | Out-Null
	Check 'the hook command runs in Git Bash' { BashRun "echo '{}' | $command" } | Out-Null
	Check 'hook uninstall' { pb hook uninstall } | Out-Null

	Check 'upgrade --force replaces pb' { pb upgrade --force } | Out-Null
	Has 'and it still runs' (Check 'version after upgrade' { pb version --local }) 'pb'
	Write-Host 'all passed'
} finally {
	Set-Location $Root
	Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
	Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Work
}
