#!/usr/bin/env bash
# Compiles the real cBot against a fake cTrader runtime and runs it against a
# local server (needs Mono: apt-get install mono-mcs libmono-system-net-http4.0-cil).
#   1. INGEST_TOKEN=test-token-1234567890 PORT=3456 node server/index.js
#   2. bash ctrader/test/run.sh
set -euo pipefail
cd "$(dirname "$0")"
mcs -nologo -r:System.Net.Http.dll -out:/tmp/xau-cbot-harness.exe CAlgoFake.cs Harness.cs ../XauAiFeeder.cs
mono /tmp/xau-cbot-harness.exe
