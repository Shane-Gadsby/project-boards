#!/bin/sh
# Installs or upgrades Project Boards from this unpacked bundle, as root, on RHEL 8 or 9. Safe to run again: it never
# touches /etc/project-boards/project-boards.env once it exists, or the data in /var/lib/project-boards.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP=/opt/project-boards
ETC=/etc/project-boards

[ "$(id -u)" = 0 ] || { echo "run this as root" >&2; exit 1; }
# The first Node.js 18 or newer: $NODE if set, then PATH, then the usual places, then nvm's versions, newest first
# (nvm only sets PATH in interactive shells, so sudo and scripts do not see it).
NVM_HOMES=${HOME:-/root}
if [ -n "${SUDO_USER:-}" ]; then
	NVM_HOMES="$NVM_HOMES $(getent passwd "$SUDO_USER" | cut -d: -f6)"
fi
NVM_NODES=$(for h in $NVM_HOMES; do ls -d "$h"/.nvm/versions/node/*/bin/node 2>/dev/null || true; done | sort -Vr)
NODE_OK=
NODE_SEEN=
for c in "${NODE:-}" "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /usr/bin/node $NVM_NODES; do
	[ -n "$c" ] && [ -x "$c" ] || continue
	if "$c" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null; then
		NODE_OK=$c
		break
	fi
	NODE_SEEN="$NODE_SEEN $c ($("$c" --version 2>/dev/null))"
done
if [ -z "$NODE_OK" ]; then
	echo "Node.js 18 or newer is needed.${NODE_SEEN:+ Found:$NODE_SEEN.} See docs/install-rhel.md, or pass one: NODE=/path/to/node ./install.sh" >&2
	exit 1
fi
if [ -n "${NODE:-}" ] && [ "$NODE_OK" != "$NODE" ]; then
	echo "NODE=$NODE is not usable: it must be Node.js 18 or newer" >&2
	exit 1
fi

getent group project-boards >/dev/null || groupadd --system project-boards
getent passwd project-boards >/dev/null || useradd --system --gid project-boards --home-dir /var/lib/project-boards --no-create-home --shell /sbin/nologin project-boards

# A staged copy and a swap, so a failure part way leaves the running version whole.
rm -rf "$APP.new" "$APP.old"
mkdir -p "$APP.new"
cp -r "$HERE/server.js" "$HERE/lib" "$HERE/public" "$HERE/bin" "$HERE/docs" "$HERE/VERSION" "$APP.new/"
# The service cannot see home folders (ProtectHome) and runs as its own user, so a Node.js in one, like nvm's in /root,
# is copied in. Run this again to pick up a newer one.
NODE_REAL=$(readlink -f "$NODE_OK")
NODE_BIN=$NODE_OK
case "$NODE_REAL" in
	/root/* | /home/* | "$APP"/*) COPY_NODE=1 ;; # the last: this install is about to replace $APP
	*) if runuser -u project-boards -- "$NODE_REAL" --version >/dev/null 2>&1; then COPY_NODE=0; else COPY_NODE=1; fi ;;
esac
if [ "$COPY_NODE" = 1 ]; then
	mkdir -p "$APP.new/runtime"
	cp "$NODE_REAL" "$APP.new/runtime/node"
	NODE_BIN=$APP/runtime/node
fi
chown -R root:root "$APP.new"
chmod -R u=rwX,go=rX "$APP.new"
if [ -d "$APP" ]; then mv "$APP" "$APP.old"; fi
mv "$APP.new" "$APP"
rm -rf "$APP.old"
command -v restorecon >/dev/null 2>&1 && restorecon -R "$APP" || true
if [ "$COPY_NODE" = 1 ] && command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
	chcon -t bin_t "$NODE_BIN" || true
fi
runuser -u project-boards -- "$NODE_BIN" --version >/dev/null \
	|| { echo "the service user cannot run $NODE_BIN; install Node.js system-wide (see docs/install-rhel.md)" >&2; exit 1; }
echo "Using Node.js $("$NODE_BIN" --version) at $NODE_BIN"

# Here as well as from systemd: the password is set before the first start.
install -d -o project-boards -g project-boards -m 750 /var/lib/project-boards /var/lib/project-boards/projects
mkdir -p "$ETC"
if [ ! -f "$ETC/project-boards.env" ]; then
	install -m 640 -o root -g project-boards "$HERE/packaging/rhel/project-boards.env" "$ETC/project-boards.env"
	NEW_CONFIG=1
fi
sed "s|^ExecStart=.*|ExecStart=$NODE_BIN $APP/server.js|" "$HERE/packaging/rhel/project-boards.service" >/etc/systemd/system/project-boards.service
chmod 644 /etc/systemd/system/project-boards.service
rm -f "$ETC/nginx-project-boards.conf.example"
install -m 644 "$HERE/packaging/rhel/haproxy-project-boards.cfg" "$ETC/haproxy-project-boards.cfg.example"
cat > /usr/local/sbin/project-boards-admin <<SCRIPT
#!/bin/sh
# The board's password and login mode, as the service user, on the service's data.
exec runuser -u project-boards -- env PB_DATA=/var/lib/project-boards $NODE_BIN $APP/bin/pb-admin "\$@"
SCRIPT
chmod 755 /usr/local/sbin/project-boards-admin

# Updating from the board's page: the service asks by writing a file, and this root unit installs that release.
install -d -m 755 /var/lib/project-boards-updater
install -d -o project-boards -g project-boards -m 750 /var/lib/project-boards/update
install -m 755 "$HERE/packaging/rhel/install-server.sh" /usr/local/sbin/project-boards-install-server
sed "s|@NODE@|$NODE_BIN|" "$HERE/packaging/rhel/project-boards-update" >/usr/local/sbin/project-boards-update
chmod 755 /usr/local/sbin/project-boards-update
install -m 644 "$HERE/packaging/rhel/project-boards-update.service" "$HERE/packaging/rhel/project-boards-update.path" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now project-boards-update.path >/dev/null 2>&1
systemctl enable project-boards >/dev/null 2>&1
if [ "${NEW_CONFIG:-0}" = 1 ]; then
	echo "Installed $(cat "$APP/VERSION"). Next: set PB_PUBLIC_URL in $ETC/project-boards.env, run"
	echo "  project-boards-admin set-password"
	echo "  systemctl start project-boards"
else
	systemctl restart project-boards
	echo "Upgraded to $(cat "$APP/VERSION") and restarted."
fi
