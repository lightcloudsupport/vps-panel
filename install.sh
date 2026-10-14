#!/usr/bin/env bash
# LightCloud installer for Ubuntu/Debian. Run as root:  sudo bash install.sh
set -e
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash install.sh"; exit 1; }
apt-get update
apt-get install -y curl ca-certificates build-essential python3 docker.io
systemctl enable --now docker
if ! command -v node >/dev/null || ! node -v | grep -Eq '^v(18|20|22)'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
DIR=/opt/lightcloud
mkdir -p "$DIR"
[ "$PWD" = "$DIR" ] || cp -r . "$DIR"/
cd "$DIR"
npm install --omit=dev
docker pull rastasheep/ubuntu-sshd:18.04
if [ ! -f .env ]; then
  read -rp "Admin key [admin123]: " KEY; KEY=${KEY:-admin123}
  IP=$(curl -fsS https://ifconfig.me || hostname -I | awk '{print $1}')
  read -rp "Public address of this server [$IP]: " HOSTN; HOSTN=${HOSTN:-$IP}
  cat > .env <<EOF
PORT=3000
SESSION_SECRET=$(head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9)
PUBLIC_HOST=$HOSTN
ADMIN_KEY=$KEY
EOF
fi
cat > /etc/systemd/system/lightcloud.service <<EOF
[Unit]
Description=LightCloud panel
After=network.target docker.service
[Service]
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=$(command -v node) server.js
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now lightcloud
echo
echo "LightCloud is running on port 3000. Open http://$(grep PUBLIC_HOST .env | cut -d= -f2):3000"
echo "Allow ports 3000 and 20000-30000 (VPS SSH) in your firewall, plus any port you forward."
echo "Logs: journalctl -u lightcloud -f"
