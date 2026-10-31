#!/bin/sh
# Installs or upgrades Project Boards from this unpacked bundle, as root, on RHEL 8 or 9. Safe to run again: it never
# touches /etc/project-boards/project-boards.env once it exists, or the data in /var/lib/project-boards.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP=/opt/project-boards
ETC=/etc/project-boards

[ "$(id -u)" = 0 ] || { echo "run this as root" >&2; exit 1; }
[ -x /usr/bin/node ] || { echo "/usr/bin/node not found: install Node.js 18 or newer first (see docs/install-rhel.md)" >&2; exit 1; }
/usr/bin/node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
	|| { echo "Node.js 18 or newer is needed; found $(/usr/bin/node --version) (see docs/install-rhel.md)" >&2; exit 1; }

getent group project-boards >/dev/null || groupadd --system project-boards
getent passwd project-boards >/dev/null || useradd --system --gid project-boards --home-dir /var/lib/project-boards --no-create-home --shell /sbin/nologin project-boards

# A staged copy and a swap, so a failure part way leaves the running version whole.
rm -rf "$APP.new" "$APP.old"
mkdir -p "$APP.new"
cp -r "$HERE/server.js" "$HERE/lib" "$HERE/public" "$HERE/bin" "$HERE/docs" "$HERE/VERSION" "$APP.new/"
chown -R root:root "$APP.new"
chmod -R u=rwX,go=rX "$APP.new"
if [ -d "$APP" ]; then mv "$APP" "$APP.old"; fi
mv "$APP.new" "$APP"
rm -rf "$APP.old"
command -v restorecon >/dev/null 2>&1 && restorecon -R "$APP" || true

# Here as well as from systemd: the password is set before the first start.
install -d -o project-boards -g project-boards -m 750 /var/lib/project-boards /var/lib/project-boards/projects
mkdir -p "$ETC"
if [ ! -f "$ETC/project-boards.env" ]; then
	install -m 640 -o root -g project-boards "$HERE/packaging/rhel/project-boards.env" "$ETC/project-boards.env"
	NEW_CONFIG=1
fi
install -m 644 "$HERE/packaging/rhel/project-boards.service" /etc/systemd/system/project-boards.service
install -m 644 "$HERE/packaging/rhel/nginx-project-boards.conf" "$ETC/nginx-project-boards.conf.example"
cat > /usr/local/sbin/project-boards-admin <<'SCRIPT'
#!/bin/sh
# The board's password and login mode, as the service user, on the service's data.
exec runuser -u project-boards -- env PB_DATA=/var/lib/project-boards /usr/bin/node /opt/project-boards/bin/pb-admin "$@"
SCRIPT
chmod 755 /usr/local/sbin/project-boards-admin

systemctl daemon-reload
systemctl enable project-boards >/dev/null 2>&1
if [ "${NEW_CONFIG:-0}" = 1 ]; then
	echo "Installed $(cat "$APP/VERSION"). Next: set PB_PUBLIC_URL in $ETC/project-boards.env, run"
	echo "  project-boards-admin set-password"
	echo "  systemctl start project-boards"
else
	systemctl restart project-boards
	echo "Upgraded to $(cat "$APP/VERSION") and restarted."
fi
