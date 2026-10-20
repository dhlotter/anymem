#!/usr/bin/env bash
# Builds a fake token at runtime and writes it into the empty workspace.
# No secret literal lives in this file. Runs only with --scaffold.
set -eu
mkdir -p notes
body="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 36)"
printf 'github token: %s%s\n' 'ghp_' "$body" > notes/token.txt
