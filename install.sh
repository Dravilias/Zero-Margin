#!/usr/bin/env bash
# Installs Zero Margin for the current user on Linux. No root needed.
#   ./install.sh               install, building the game first if there's no package yet
#   ./install.sh --rebuild     build a fresh package, then install it
#   ./install.sh --uninstall   remove the game (saves and settings are kept)
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_HOME/zero-margin"
APP_FILE="$APP_DIR/ZeroMargin.AppImage"
BIN_LINK="$HOME/.local/bin/zero-margin"
DESKTOP_FILE="$DATA_HOME/applications/zero-margin.desktop"
ICON_FILE="$DATA_HOME/icons/hicolor/512x512/apps/zero-margin.png"

refresh_menu() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
  fi
}

uninstall() {
  rm -f "$APP_FILE" "$BIN_LINK" "$DESKTOP_FILE" "$ICON_FILE"
  rmdir "$APP_DIR" 2>/dev/null || true
  refresh_menu
  echo "Zero Margin is uninstalled. Your saves and settings were kept."
}

find_package() {
  # A fresh copy has no release folder yet, which just means nothing has been built.
  [ -d release ] || return 0
  find release -maxdepth 1 -name 'ZeroMargin-*-linux-*.AppImage' | sort -V | tail -n 1
}

build() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "Building the game needs Node.js and npm. Install them, then run this again." >&2
    exit 1
  fi
  echo "Building the game. This can take a few minutes..."
  npm ci
  npm run dist:linux
}

case "${1:-}" in
  --uninstall) uninstall; exit 0 ;;
  --rebuild) build ;;
  "") ;;
  *) echo "Usage: ./install.sh [--rebuild | --uninstall]" >&2; exit 1 ;;
esac

PACKAGE="$(find_package)"
if [ -z "$PACKAGE" ]; then
  build
  PACKAGE="$(find_package)"
fi
if [ -z "$PACKAGE" ]; then
  echo "The build finished, but no AppImage was found in release/." >&2
  exit 1
fi

mkdir -p "$APP_DIR" "$(dirname "$BIN_LINK")" "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON_FILE")"
# Copy then rename, so reinstalling works even while the game is running.
install -m 755 "$PACKAGE" "$APP_FILE.new"
mv -f "$APP_FILE.new" "$APP_FILE"
install -m 644 build/icon.png "$ICON_FILE"
ln -sf "$APP_FILE" "$BIN_LINK"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Zero Margin
Comment=Cyberpunk tabletop game: skirmish, story campaign and card duel
Exec="$APP_FILE" %U
Icon=zero-margin
Terminal=false
Categories=Game;StrategyGame;
StartupWMClass=zero-margin
EOF

refresh_menu

echo "Installed $(basename "$PACKAGE")."
echo "Find Zero Margin in your app menu, or run: zero-margin"

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Note: $HOME/.local/bin isn't on your PATH, so the zero-margin command won't work until you add it. The app menu entry still will." ;;
esac

if ! command -v fusermount >/dev/null 2>&1 && ! command -v fusermount3 >/dev/null 2>&1; then
  echo "Note: AppImages need FUSE, and it doesn't look installed. If the game won't start, install your system's fuse package."
fi
