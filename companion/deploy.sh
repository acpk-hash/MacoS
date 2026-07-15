#!/bin/bash
# Deploy Iris Companion PWA to VPS
# Usage: bash deploy.sh [VPS_HOST] [VPS_USER]
set -euo pipefail

VPS_HOST="${1:-192.210.231.152}"
VPS_USER="${2:-root}"
DEPLOY_DIR="/var/www/iris-companion"

echo "=== Building companion PWA ==="
cd "$(dirname "$0")"
npm ci --silent
npm run build

echo "=== Deploying to ${VPS_USER}@${VPS_HOST} ==="
ssh "${VPS_USER}@${VPS_HOST}" "mkdir -p ${DEPLOY_DIR}"
scp -r dist/* "${VPS_USER}@${VPS_HOST}:${DEPLOY_DIR}/"

echo "=== Configuring nginx ==="
scp nginx.conf "${VPS_USER}@${VPS_HOST}:/etc/nginx/sites-available/iris-companion"
ssh "${VPS_USER}@${VPS_HOST}" bash -s <<'REMOTE'
  set -e
  # Enable site
  ln -sf /etc/nginx/sites-available/iris-companion /etc/nginx/sites-enabled/iris-companion
  # Remove default if it conflicts on port 80
  rm -f /etc/nginx/sites-enabled/default
  # Install nginx if missing
  if ! command -v nginx &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq nginx
  fi
  # Test and reload
  nginx -t && systemctl reload nginx
  echo "OK: nginx configured and reloaded"
REMOTE

echo ""
echo "=== Deployment complete ==="
echo "Open https://${VPS_HOST}/ on your phone"
echo "(Accept the self-signed certificate on first visit)"
