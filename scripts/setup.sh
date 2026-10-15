#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22+ diperlukan")'
command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null
if [[ -n "${CHROME_PATH:-}" ]]; then
  test -x "$CHROME_PATH"
elif [[ ! -x /usr/bin/chromium ]]; then
  echo 'Pasang Chromium dan set CHROME_PATH ke executable-nya.' >&2
  exit 1
fi
npm ci
npm run build
npm test
