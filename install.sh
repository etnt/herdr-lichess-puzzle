#!/bin/sh
# Installs the lichess-daily mod into Herdr's mods folder.
#
# A symlink works (verified with `herdr-app check`), so by default this just
# links the repo folder — edits in the repo show up live in Herdr. Use
# `install.sh copy` if a copy is preferred (or if a Herdr version ever stops
# following symlinks).
set -eu

REPO="$(cd "$(dirname "$0")" && pwd)"
MODS="$HOME/.config/herdr-app/mods"
NAME="lichess-daily"

mkdir -p "$MODS"

if [ "${1:-link}" = "copy" ]; then
  rm -rf "$MODS/$NAME"
  cp -R "$REPO/$NAME" "$MODS/$NAME"
  echo "Installed (copy): $MODS/$NAME"
else
  [ -e "$MODS/$NAME" ] || [ -L "$MODS/$NAME" ] || { ln -s "$REPO/$NAME" "$MODS/$NAME"; }
  echo "Installed (symlink): $MODS/$NAME -> $REPO/$NAME"
fi

echo "Then add the mod to your layout (see README.md) and reload Herdr."
