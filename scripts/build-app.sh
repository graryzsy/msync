#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  ''|--with-companion) npm run package:mac ;;
  --intel) npm run package:mac:x64 ;;
  *) echo '用法：scripts/build-app.sh [--intel]；也可直接使用 npm run package:mac' >&2; exit 1 ;;
esac
