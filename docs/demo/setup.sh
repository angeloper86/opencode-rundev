#!/bin/sh
# Builds the throwaway workspace used by docs/demo.tape (the README screenshots).
#
# Test data only: three fake repos whose services are `sleep` processes, so the
# sidebar shows real pids and real liveness. Nothing touches a real project.
#
#   sh docs/demo/setup.sh && vhs docs/demo.tape
set -eu

ROOT=/tmp/rundev-demo
R="$ROOT/acme"
HERE=$(cd "$(dirname "$0")/../.." && pwd)

rm -rf "$R"
mkdir -p "$R/acme-api/.opencode" "$R/acme-web/.opencode" "$R/acme-app/.opencode"

cat > "$R/acme-api/.opencode/rundev.json" <<'JSON'
{
  "version": 1,
  "default": ["db", "api"],
  "services": {
    "db": { "kind": "process", "up": "sleep 86400", "check": "true", "port": 5432 },
    "api": { "kind": "process", "up": "sleep 86400", "check": "true", "port": 4000, "health": "http://localhost:4000/health" },
    "worker": { "kind": "process", "up": "sleep 86400", "check": "true" }
  }
}
JSON

cat > "$R/acme-web/.opencode/rundev.json" <<'JSON'
{
  "version": 1,
  "default": ["web"],
  "services": {
    "web": { "kind": "process", "up": "sleep 86400", "check": "true", "port": 5173, "health": "http://localhost:5173" },
    "browser": { "kind": "browser", "url": "http://localhost:5173", "profile": ".opencode/.chrome-profile" }
  }
}
JSON

cat > "$R/acme-app/.opencode/rundev.json" <<'JSON'
{
  "version": 1,
  "default": ["app"],
  "services": {
    "emulator": { "kind": "process", "up": "sleep 86400", "check": "true" },
    "app": { "kind": "process", "up": "sleep 86400", "check": "true" }
  }
}
JSON

cat > "$R/rundev.workspace.json" <<'JSON'
{
  "name": "acme",
  "members": ["acme-api", "acme-web", "acme-app"],
  "dependencies": { "acme-web": ["acme-api"], "acme-app": ["acme-api"] }
}
JSON

# start the fake services for real (real pids, real liveness in the sidebar)
for m in acme-api acme-web acme-app; do
  (cd "$HERE" && node --experimental-strip-types --no-warnings dev/harness.ts "$R/$m" up >/dev/null)
done
(cd "$HERE" && node --experimental-strip-types --no-warnings dev/harness.ts "$R/acme-api" "up worker" >/dev/null)
(cd "$HERE" && node --experimental-strip-types --no-warnings dev/harness.ts "$R/acme-app" "up emulator" >/dev/null)

echo "demo workspace ready: $R"
echo "record the screenshots with: vhs docs/demo.tape"
echo "stop the fake services with: pkill -f 'sleep 86400'"
