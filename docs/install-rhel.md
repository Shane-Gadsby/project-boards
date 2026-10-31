# Installing Project Boards on RHEL 8 or 9

A board server is one Node.js process with no packages to install and no database: it keeps flat files in
`/var/lib/project-boards`. The bundle installs it as a systemd service under its own user. Everything below runs as root.

## 1. Node.js 18 or newer

Use Red Hat's AppStream modules (RHEL 8's default stream is too old). See which streams your release offers, then pick
the newest listed:

```bash
dnf module list nodejs
dnf module reset -y nodejs
dnf module install -y nodejs:20/common     # or the newest stream listed
node --version
```

The server needs no compiler, npm packages or outside network access. An offline machine only needs these packages from
its local mirror, and the bundle copied to it.

## 2. Install the bundle

Get `project-boards-<version>.tar.gz` from whoever runs your distribution (it is built by `scripts/make-dist.sh`), check it
against its `.sha256`, and run:

```bash
tar xzf project-boards-<version>.tar.gz
cd project-boards-<version>
./install.sh
```

This puts the code in `/opt/project-boards` (root-owned; the service cannot change it), creates the `project-boards` user,
installs `project-boards.service`, and adds `project-boards-admin`.

## 3. Configure and start

In `/etc/project-boards/project-boards.env`, set `PB_PUBLIC_URL` to the address people will use. `pb` remembers it as its
home, so use the final address.

```bash
project-boards-admin set-password      # at least 10 characters
systemctl start project-boards
curl -s http://127.0.0.1:4780/api/health
```

Logins are required from the start (`PB_AUTH=required`).

## 4. TLS with nginx

The server speaks plain HTTP, so anything beyond one machine should go through a TLS proxy: passwords and tokens would
otherwise cross the network in the clear.

```bash
dnf install -y nginx
cp /etc/project-boards/nginx-project-boards.conf.example /etc/nginx/conf.d/project-boards.conf
# set server_name and the certificate paths in that file
setsebool -P httpd_can_network_connect 1   # SELinux: lets nginx connect to the service's port
firewall-cmd --permanent --add-service=https --add-service=http
firewall-cmd --reload
systemctl enable --now nginx
```

The proxy must keep long responses open and unbuffered: the shipped file does. A different proxy needs the same, and must
pass `X-Forwarded-Proto` and `X-Forwarded-Host`.

Without a proxy, for a trial on a trusted network: set `PB_HOST=0.0.0.0`, then
`firewall-cmd --permanent --add-port=4780/tcp && firewall-cmd --reload`.

## 5. Put client machines on it

On each machine running Claude Code (Node.js 18 or newer):

- **No `pb` yet:** `curl -fsSL https://<your board>/install | sh`, then `pb login`.
- **Already has `pb` from another board:** keep it. In each project that belongs on this board, run
  `pb use https://<your board> --project <slug>`, then `pb login`.

Give a session `https://<your board>/enrol` to bring a project on, or `https://<your board>/upgrade` for one already on a
board. If your certificate comes from an internal CA, the machine's Node.js must trust it, for example with
`NODE_EXTRA_CA_CERTS=/etc/pki/ca-trust/source/anchors/your-ca.pem`.

## Running it

| | |
|---|---|
| Status and logs | `systemctl status project-boards`, `journalctl -u project-boards -f` |
| Password, login mode | `project-boards-admin set-password`, `project-boards-admin status` |
| Upgrade | Unpack the new bundle and run its `./install.sh`. Settings and data are kept, the service restarts. This drops open pages and `pb wait` calls for a moment; both recover. |
| Back up | `/var/lib/project-boards` and `/etc/project-boards`. Plain files; a copy taken while it runs is fine for anything but the last few writes. |
| Remove | `systemctl disable --now project-boards`, then delete `/opt/project-boards`, `/etc/project-boards`, `/etc/systemd/system/project-boards.service`, `/usr/local/sbin/project-boards-admin`, and the data if you mean to. |
