#!/bin/bash
# Build Iris for macOS locally (run on a Mac)
set -euo pipefail

ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64|aarch64) RUST_TARGET="aarch64-apple-darwin" ;;
  x86_64|x64)    RUST_TARGET="x86_64-apple-darwin" ;;
  *)             echo "Unknown arch: $ARCH"; exit 1 ;;
esac

echo "=== Building Iris for macOS $ARCH ($RUST_TARGET) ==="

# Install dependencies
npm ci

# Prepare engine-pi (macOS node binary)
NODE_VERSION="22.17.0"
rm -rf engine-pi /tmp/iris-pi
mkdir -p engine-pi/pi /tmp/iris-pi
curl -fsSLo /tmp/node.tar.gz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
tar -xzf /tmp/node.tar.gz -C /tmp
cp "/tmp/node-v${NODE_VERSION}-darwin-${ARCH}/bin/node" engine-pi/node
chmod 755 engine-pi/node
npm install --prefix /tmp/iris-pi @earendil-works/pi-coding-agent
cp -R /tmp/iris-pi/node_modules/@earendil-works/pi-coding-agent/. engine-pi/pi/
cp -R /tmp/iris-pi/node_modules engine-pi/pi/node_modules

# Build
npm run tauri -- build --target "$RUST_TARGET" --config src-tauri/tauri.macos.conf.json

echo "=== Build complete ==="
echo "DMG: src-tauri/target/$RUST_TARGET/release/bundle/dmg/"
echo "App: src-tauri/target/$RUST_TARGET/release/bundle/macos/"
