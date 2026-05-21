#!/usr/bin/env bash
set -euo pipefail

# 사용법:
#   API_KEY="..." ENDPOINT="..." ./run.sh "hello world!"
# 또는 .env 파일 생성 후:
#   cp .env.example .env
#   . ./.env
#   ./run.sh "hello world!"

BASE_URL="${BASE_URL:-https://agent.sec.samsung.net}"
API_KEY="${API_KEY:-}"
ENDPOINT="${ENDPOINT:-}"
INPUT_VALUE="${1:-hello world!}"

if [[ -z "$API_KEY" || -z "$ENDPOINT" ]]; then
  echo "ERROR: API_KEY and ENDPOINT must be set. See .env.example" >&2
  exit 1
fi

curl --request POST \
  --url "${BASE_URL}/api/v1/run/${ENDPOINT}?stream=true" \
  --header "Content-Type: application/json" \
  --header "x-api-key: ${API_KEY}" \
  --data "$(printf '{"input_type":"chat","output_type":"chat","input_value":%s}' "$(python -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$INPUT_VALUE")")"
