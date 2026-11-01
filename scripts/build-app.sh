#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "桌面应用打包需要 macOS 15 和 Xcode 16 或更新版本。" >&2
    exit 1
fi

MSYNC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MSYNC_ROOT"
MSYNC_WITH_COMPANION="${1:-}"
if [[ -n "$MSYNC_WITH_COMPANION" && "$MSYNC_WITH_COMPANION" != "--with-companion" ]]; then
    echo "用法：scripts/build-app.sh [--with-companion]" >&2
    exit 1
fi

swift build --configuration release --product MSync
MSYNC_BIN_PATH="$(swift build --configuration release --show-bin-path)"
MSYNC_APP="$MSYNC_ROOT/dist/MSync.app"
mkdir -p "$MSYNC_APP/Contents/MacOS" "$MSYNC_APP/Contents/Resources"
cp "$MSYNC_BIN_PATH/MSync" "$MSYNC_APP/Contents/MacOS/MSync"
cp Resources/Info.plist "$MSYNC_APP/Contents/Info.plist"
cp Sources/MSyncAdapters/Resources/MusicBridge.js "$MSYNC_APP/Contents/Resources/MusicBridge.js"
for MSYNC_RESOURCE in "$MSYNC_BIN_PATH"/MSync_MSyncAdapters.bundle "$MSYNC_BIN_PATH"/MSync_MSyncAdapters.resources; do
    if [[ -d "$MSYNC_RESOURCE" ]]; then
        ditto "$MSYNC_RESOURCE" "$MSYNC_APP/Contents/Resources/$(basename "$MSYNC_RESOURCE")"
    fi
done

if [[ "$MSYNC_WITH_COMPANION" == "--with-companion" ]]; then
    (cd Companion && npm ci --ignore-scripts --no-audit --no-fund && npm run build)
    mkdir -p "$MSYNC_APP/Contents/Resources/Companion"
    cp Companion/package.json Companion/package-lock.json "$MSYNC_APP/Contents/Resources/Companion/"
    ditto Companion/dist "$MSYNC_APP/Contents/Resources/Companion/dist"
    ditto Companion/node_modules "$MSYNC_APP/Contents/Resources/Companion/node_modules"
fi

# Ad-hoc signing is sufficient for a locally built personal Mac application.
# No paid Apple Developer membership, signing identity, or notarization request is used.
codesign --force --deep --sign - "$MSYNC_APP"
echo "已生成：$MSYNC_APP"
echo "运行：open \"$MSYNC_APP\""
if [[ "$MSYNC_WITH_COMPANION" == "--with-companion" ]]; then
    echo "网易云辅助模块已打包；首次使用仍需在连接设置中选择本机 Node.js 22+。"
fi
