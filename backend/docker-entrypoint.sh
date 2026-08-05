#!/bin/sh
set -e

# Every step logs for itself, through the Nest Logger, so the whole startup
# sequence reads in one format. Do not add `echo` here: a shell echo is the one
# line in the container log without a timestamp, level, or context (guarded by
# src/startup-logging.spec.ts).

node dist/db-init.js

node dist/db-migrate.js

# In demo mode, seed the demo user and data if not already present
if [ "$DEMO_MODE" = "true" ]; then
  node dist/db-demo-check.js || node dist/database/seed.js
fi

exec node dist/main.js
