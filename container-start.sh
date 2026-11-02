#!/bin/sh
# Root-owned launcher. No user-owned executable runs before dropping privileges.
set -eu
if [ "$(/usr/bin/id -u)" != 0 ]; then
  echo 'Cora launcher must be started by the host Docker controller.' >&2
  exit 1
fi
set -a
. /etc/lark-agent-bridge-cora/environment.sh
set +a
cd /home/main/workspaces
if [ "$#" -eq 0 ]; then
  set -- /home/main/.local/nodejs/bin/node /home/main/lark-agent-bridge/bridge.mjs
fi
exec /usr/bin/setpriv --reuid=1000 --regid=1000 --groups=100,1000 --no-new-privs \
  -- "$@"
