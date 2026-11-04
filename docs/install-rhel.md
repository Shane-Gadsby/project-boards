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

## 2. Install

As root, this downloads the latest release, checks its checksum, unpacks it and runs its installer:

```bash
curl -fsSL https://github.com/Shane-Gadsby/project-boards/releases/latest/download/install-server.sh | sh
```

With `sudo`, pipe it to `sudo sh` instead.

Run it again to upgrade. For one version, set `PB_VERSION=1.7.1`, on the `sh` side of the pipe.

Without internet access, copy over `project-boards-<version>.tar.gz` from the release page and its `.sha256`, then:

```bash
sha256sum -c project-boards-<version>.tar.gz.sha256
tar xzf project-boards-<version>.tar.gz
cd project-boards-<version>
./install.sh
```

Behind a proxy, `curl` uses `https_proxy` from your shell. For the board's **Updates** button, the service needs it too: put
`https_proxy` and `no_proxy` in `/etc/environment` or `/etc/project-boards/project-boards.env`, then restart the service.

The installer uses Node.js 18 or newer from `NODE`, then `PATH`, then `/usr/local/bin` and `/usr/bin`, then nvm's versions
(root's, and the `sudo` user's), newest first. The service runs the one it found.

**With nvm:** the service cannot read a home folder, so the installer copies that Node.js to
`/opt/project-boards/runtime/node`. `nvm use` does not affect the service; run the installer again to move it to a newer one.

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

## 4. TLS with HAProxy

The server speaks plain HTTP, so anything beyond one machine should go through a TLS proxy: passwords and tokens would
otherwise cross the network in the clear.

```bash
dnf install -y haproxy
mkdir -p /etc/haproxy/certs /etc/haproxy/conf.d
cat your-certificate-chain.crt your-private.key > /etc/haproxy/certs/boards.example.com.pem
chmod 600 /etc/haproxy/certs/boards.example.com.pem
```

Save this as `/etc/haproxy/conf.d/project-boards.cfg`, with your certificate's path:

```haproxy
# /etc/haproxy/conf.d/project-boards.cfg: TLS in front of Project Boards. Set the certificate path.
# The PEM file holds the certificate chain and the private key together.
frontend project_boards
	mode http
	bind *:80
	bind *:443 ssl crt /etc/haproxy/certs/boards.example.com.pem
	http-request redirect scheme https code 301 unless { ssl_fc }
	http-request set-header X-Forwarded-Proto https
	http-request set-header X-Forwarded-Host %[req.hdr(host)]
	option forwardfor
	# Live page updates and pb wait hold a response open.
	timeout client 3700s
	default_backend project_boards

backend project_boards
	mode http
	option httpchk GET /api/health
	timeout server 3700s
	server app 127.0.0.1:4780 check
```

Then check it and start HAProxy:

```bash
haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/conf.d
setsebool -P haproxy_connect_any 1   # SELinux: lets HAProxy connect to the service's port
firewall-cmd --permanent --add-service=https --add-service=http
firewall-cmd --reload
systemctl enable --now haproxy
```

RHEL's stock `/etc/haproxy/haproxy.cfg` has a sample `main` frontend on port 5000 whose servers do not exist, so the log
reports them as down. That is harmless, and you can remove the sample.

The proxy must keep long responses open: this file does, with one-hour client and server timeouts. A different
proxy needs the same, and must pass `X-Forwarded-Proto` and `X-Forwarded-Host`.

To put the board under a sub-path of a domain that serves other things, route that path to it and keep the rest, then set
`PB_BASE_PATH=/projects` and `PB_PUBLIC_URL=https://blah.com/projects` in the env file. In the HAProxy frontend:

```haproxy
acl is_boards path /projects
acl is_boards path_beg /projects/
use_backend project_boards if is_boards
```

Without a proxy, for a trial on a trusted network: set `PB_HOST=0.0.0.0`, then
`firewall-cmd --permanent --add-port=4780/tcp && firewall-cmd --reload`.

## 5. Put client machines on it

On each machine running Claude Code (Node.js 18 or newer):

- **No `pb` yet:** `curl -fsSL https://<your board>/install | sh`, then `pb login` using the path it prints. It installs to
  `~/.local/share/project-boards`, which is not on `PATH`; link it into a folder that is, as the installer explains.
  On Windows, from PowerShell: `irm https://<your board>/install.ps1 | iex` (it adds itself to the user's PATH).

`pb` belongs on the machines running Claude Code. The server install does not add it, and the board server needs it only
if Claude Code runs there too. `pb` runs on whichever `node` is on `PATH`, so with nvm use it from a shell where nvm is loaded.
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
| Upgrade | Use the **Updates** button on the board when signed in, or run the install command again. Settings and data are kept, the service restarts. This drops open pages and `pb wait` calls for a moment; both recover. |
| Back up | `/var/lib/project-boards` and `/etc/project-boards`. Plain files; a copy taken while it runs is fine for anything but the last few writes. |
| Remove | `systemctl disable --now project-boards`, then delete `/opt/project-boards`, `/etc/project-boards`, `/etc/systemd/system/project-boards.service`, `/usr/local/sbin/project-boards-admin`, and the data if you mean to. |
