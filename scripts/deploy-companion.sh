#!/bin/bash
# Deploy Iris Companion PWA to VPS
set -euo pipefail

VPS_HOST="${VPS_HOST:-192.210.231.152}"
VPS_USER="${VPS_USER:-root}"
DEPLOY_DIR="/var/www/iris-companion"

echo "=== Building companion PWA ==="
cd companion
npm ci
npm run build

echo "=== Deploying to ${VPS_HOST} ==="
ssh "${VPS_USER}@${VPS_HOST}" "mkdir -p ${DEPLOY_DIR}"
scp -r dist/* "${VPS_USER}@${VPS_HOST}:${DEPLOY_DIR}/"

echo "=== Done ==="
echo "PWA deployed to https://${VPS_HOST}/"
