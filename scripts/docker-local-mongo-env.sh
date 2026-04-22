#!/usr/bin/env bash
# Sourced after repo root `.env` (if any). Sets ARCHON_LOCAL_MONGO, compose_pf, mongo_svc.
#
# - Explicit ARCHON_LOCAL_MONGO=0|1 in .env always wins.
# - When unset/empty: if MONGODB_URI is set and is not the in-compose hostname `mongo-sync`,
#   assume remote Mongo → ARCHON_LOCAL_MONGO=0 (no mongo:7 image / container).
# - Otherwise default 1 (local dev / Jenkins).

if [[ -z "${ARCHON_LOCAL_MONGO:-}" ]]; then
  if [[ -n "${MONGODB_URI:-}" ]] && [[ "${MONGODB_URI}" != *mongo-sync* ]]; then
    ARCHON_LOCAL_MONGO=0
  else
    ARCHON_LOCAL_MONGO=1
  fi
fi
export ARCHON_LOCAL_MONGO

compose_pf=()
mongo_svc=()
if [[ "${ARCHON_LOCAL_MONGO}" == "1" ]]; then
  compose_pf=(--profile local-mongo)
  mongo_svc=(mongo-sync)
fi
