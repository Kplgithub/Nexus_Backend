#!/usr/bin/env bash
# One-time Redis install for the server. Run as root:  sudo bash scripts/setup-redis.sh
# Redis listens on 127.0.0.1 only (not reachable from the internet), needs a password,
# uses at most 200 MB of RAM and drops the least-recently-used keys when full.
# Prints the REDIS_URL to save as a GitHub secret (backend repo) at the end.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }

apt-get update -qq
apt-get install -y -qq redis-server openssl >/dev/null

CONF=/etc/redis/redis.conf
PASS_FILE=/etc/redis/nexus-redis.pass
if [ ! -f "$PASS_FILE" ]; then
  umask 077
  openssl rand -hex 24 > "$PASS_FILE"
fi
PASS=$(cat "$PASS_FILE")

# Our own settings go in a drop-in file so the package config stays untouched.
mkdir -p /etc/redis/conf.d
cat > /etc/redis/conf.d/nexus.conf <<EOF
bind 127.0.0.1 -::1
protected-mode yes
port 6379
requirepass $PASS
maxmemory 200mb
maxmemory-policy allkeys-lru
save ""
appendonly no
EOF
grep -q 'conf.d/nexus.conf' "$CONF" || echo 'include /etc/redis/conf.d/nexus.conf' >> "$CONF"

systemctl enable redis-server >/dev/null 2>&1 || true
systemctl restart redis-server
sleep 1
REDISCLI_AUTH="$PASS" redis-cli ping

echo
echo "Redis is running (local only, 200 MB cap)."
echo "Save this as GitHub secret REDIS_URL in the nexus_backend repo, then re-run the Deploy workflow:"
echo "redis://:$PASS@127.0.0.1:6379"
