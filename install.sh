#!/bin/bash
# GitHub Data Sync - Installer for SillyTavern
# Usage: bash install.sh /path/to/SillyTavern

set -e

ST_DIR="${1:-.}"

if [ ! -f "$ST_DIR/server.js" ]; then
    echo "Error: SillyTavern not found at '$ST_DIR' (server.js missing)"
    echo "Usage: bash install.sh /path/to/SillyTavern"
    exit 1
fi

PLUGIN_DIR="$ST_DIR/plugins/github-data-sync"

echo "=== GitHub Data Sync Installer ==="
echo "SillyTavern: $ST_DIR"
echo "Plugin dir:  $PLUGIN_DIR"
echo ""

# Clone or update plugin
if [ -d "$PLUGIN_DIR/.git" ]; then
    echo "[1/3] Updating existing plugin..."
    cd "$PLUGIN_DIR"
    git pull origin main
else
    echo "[1/3] Cloning plugin..."
    rm -rf "$PLUGIN_DIR"
    git clone https://github.com/JOJO666888888/sillytavern-github-sync.git "$PLUGIN_DIR"
fi

# Install dependencies
echo "[2/3] Installing dependencies..."
cd "$PLUGIN_DIR"
npm install --omit=dev

# Check config
echo "[3/3] Checking configuration..."
CONFIG="$ST_DIR/config.yaml"
if grep -q "enableServerPlugins: true" "$CONFIG" 2>/dev/null; then
    echo "  ✓ enableServerPlugins is enabled"
else
    echo "  ⚠ enableServerPlugins not set to true in config.yaml"
    echo "    Add 'enableServerPlugins: true' to $CONFIG"
fi

echo ""
echo "=== Installation complete! ==="
echo ""
echo "Next steps:"
echo "1. Restart SillyTavern"
echo "2. Refresh the browser page (Ctrl+Shift+R)"
echo "3. Go to Extensions settings > GitHub Data Sync"
echo "4. Enter your GitHub repo, branch, and token"
echo "5. Click 'Test Connection' to verify"