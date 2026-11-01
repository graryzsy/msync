#!/bin/bash
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "此检查需要 macOS 和 Music.app。" >&2
    exit 1
fi

# Read-only check. Outputs capabilities and counts rather than the user's song names.
MSYNC_DICTIONARY="$(sdef /System/Applications/Music.app)"
for MSYNC_PROPERTY in 'favorited' 'album favorited' 'release date' 'persistent ID'; do
    if /usr/bin/grep -Fq "name=\"$MSYNC_PROPERTY\"" <<< "$MSYNC_DICTIONARY"; then
        printf '已声明属性：%s\n' "$MSYNC_PROPERTY"
    else
        printf '未找到属性：%s\n' "$MSYNC_PROPERTY"
    fi
done
osascript -l JavaScript <<'JXA'
var music = Application('Music');
if (!music.running()) throw new Error('请先打开 Music.app 并完成资料库同步');
var rows = music.libraryPlaylists[0].tracks.properties();
JSON.stringify({
    libraryTrackCount: rows.length,
    tracksWithFavoriteProperty: rows.filter(function(p) { return typeof p.favorited === 'boolean'; }).length,
    tracksWithAlbumFavoriteProperty: rows.filter(function(p) { return typeof p.albumFavorited === 'boolean'; }).length,
    tracksWithReleaseDate: rows.filter(function(p) { return p.releaseDate instanceof Date; }).length
});
JXA
