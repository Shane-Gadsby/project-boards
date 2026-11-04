'use strict';

// GET /install: a shell script that downloads pb from this server, checks it against the published sha256 and puts it
// in a folder (default ~/.local/share/project-boards, or the folder given as its first argument).
function installScript({ base }) {
	return `#!/bin/sh
# Installs the Project Boards command line (pb) from ${base}.
#   curl -fsSL ${base}/install | sh                     # -> ~/.local/share/project-boards/pb
#   curl -fsSL ${base}/install | sh -s -- /some/folder  # -> /some/folder/pb
# Needs Node.js 18 or newer and curl. Run it again (or \`pb upgrade\`) to update.
set -eu
BASE='${base}'
DIR="\${1:-\${PB_INSTALL_DIR:-$HOME/.local/share/project-boards}}"

command -v node >/dev/null 2>&1 || { echo "pb needs Node.js 18 or newer; node was not found" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \\
	|| { echo "pb needs Node.js 18 or newer; found $(node --version)" >&2; exit 1; }

mkdir -p "$DIR"
TMP="$DIR/.pb.download.$$"
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$BASE/pb" -o "$TMP"
WANT=$(curl -fsSL "$BASE/api/pb" | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).sha256))')
GOT=$(node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$TMP")
if [ "$WANT" != "$GOT" ]; then
	echo "the download does not match the published checksum (got $GOT, expected $WANT); run the installer again" >&2
	exit 1
fi
chmod 755 "$TMP"
mv -f "$TMP" "$DIR/pb"
trap - EXIT

echo "Installed $("$DIR/pb" version --local) at $DIR/pb"
case ":$PATH:" in
	*":$DIR:"*) ;;
	*) echo "$DIR is not on your PATH, so plain \\\`pb\\\` will not work yet. To add it: ln -s $DIR/pb /usr/local/bin/pb (as root), or add that folder to PATH" ;;
esac
echo "Next: $DIR/pb login    (opens a browser tab where the board's owner approves this machine)"
`;
}

// GET /install.ps1: the same for Windows (PowerShell 5.1, which Windows 10 and 11 ship, or PowerShell 7). Windows cannot
// run pb by its #! line, so it also writes pb.cmd, which runs it with node, and adds the folder to the user's PATH.
function installPs1Script({ base }) {
	const q = String(base).replace(/'/g, "''");
	return `# Installs the Project Boards command line (pb) on Windows from ${base}.
#   irm ${base}/install.ps1 | iex                                            # -> %LOCALAPPDATA%\\project-boards\\pb
#   & ([scriptblock]::Create((irm ${base}/install.ps1))) C:\\some\\folder     # -> C:\\some\\folder\\pb
# Needs Node.js 18 or newer. Run it again (or \`pb upgrade\`) to update. $env:PB_INSTALL_DIR also picks the folder, and
# $env:PB_NO_PATH=1 leaves PATH alone.
& {
	param([string]$Dir)
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue'
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	$Base = '${q}'
	if (-not $Dir) { $Dir = $env:PB_INSTALL_DIR }
	if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'project-boards' }

	if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
		Write-Error 'pb needs Node.js 18 or newer; node was not found (winget install OpenJS.NodeJS.LTS, then open a new terminal)'
		return
	}
	$major = [int](node -p "process.versions.node.split('.')[0]")
	if ($major -lt 18) {
		Write-Error "pb needs Node.js 18 or newer; found $(node --version)"
		return
	}

	New-Item -ItemType Directory -Force -Path $Dir | Out-Null
	$Dir = (Resolve-Path $Dir).Path
	$tmp = Join-Path $Dir ".pb.download.$PID"
	try {
		Invoke-WebRequest -UseBasicParsing -Uri "$Base/pb" -OutFile $tmp
		$want = (Invoke-RestMethod -UseBasicParsing -Uri "$Base/api/pb").sha256
		$got = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant()
		if ($want -ne $got) {
			Write-Error "the download does not match the published checksum (got $got, expected $want); run the installer again"
			return
		}
		Move-Item -Force -Path $tmp -Destination (Join-Path $Dir 'pb')
	} finally {
		Remove-Item -Force -ErrorAction SilentlyContinue -Path $tmp
	}
	# pb.cmd lets cmd and PowerShell run plain \`pb\`; Git Bash runs the pb file itself.
	[IO.File]::WriteAllText((Join-Path $Dir 'pb.cmd'), "@node \`"%~dp0pb\`" %*\`r\`n", [Text.Encoding]::ASCII)

	$pb = Join-Path $Dir 'pb'
	Write-Host "Installed $(node $pb version --local) at $pb (run it as $Dir\\pb.cmd, or pb once that folder is on PATH)"
	$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
	$parts = @($userPath -split ';' | Where-Object { $_ })
	if (($parts | ForEach-Object { $_.TrimEnd('\\') }) -notcontains $Dir.TrimEnd('\\')) {
		if ($env:PB_NO_PATH) {
			Write-Host "$Dir is not on your PATH, so plain 'pb' will not work yet: add that folder to PATH"
		} else {
			[Environment]::SetEnvironmentVariable('Path', (@($parts) + $Dir) -join ';', 'User')
			Write-Host "Added $Dir to your PATH; terminals opened from now on find pb"
		}
	}
	if (($env:Path -split ';' | ForEach-Object { $_.TrimEnd('\\') }) -notcontains $Dir.TrimEnd('\\')) {
		$env:Path = "$env:Path;$Dir"
	}
	Write-Host "Next: pb login    (opens a browser tab where the board's owner approves this machine)"
} @args
`;
}

module.exports = { installScript, installPs1Script };
