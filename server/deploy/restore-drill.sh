#!/usr/bin/env bash
# 恢复演练：把最新备份恢复到一个临时库，核对行数后删除，不碰生产库
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "[drill] 缺少 .env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

OUT_DIR="${BACKUP_DIR:-./backups}"
FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(ls -t "$OUT_DIR"/ali_cloud_*.dump 2>/dev/null | head -n 1 || true)"
fi
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "[drill] 找不到备份文件" >&2
  exit 1
fi

DRILL="ali_cloud_drill"
USER_ID="${POSTGRES_USER:-ali}"
START="$(date +%s)"

docker compose -f docker-compose.prod.yml exec -T db psql -U "$USER_ID" -d postgres \
  -c "DROP DATABASE IF EXISTS ${DRILL}" >/dev/null
docker compose -f docker-compose.prod.yml exec -T db psql -U "$USER_ID" -d postgres \
  -c "CREATE DATABASE ${DRILL}" >/dev/null

docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U "$USER_ID" -d "$DRILL" --no-owner < "$FILE"

echo "[drill] 行数核对："
docker compose -f docker-compose.prod.yml exec -T db psql -U "$USER_ID" -d "$DRILL" \
  -c "SELECT kind, count(*) AS rows FROM current_record GROUP BY kind ORDER BY kind;"
docker compose -f docker-compose.prod.yml exec -T db psql -U "$USER_ID" -d "$DRILL" \
  -c "SELECT count(*) AS batches FROM source_batch WHERE status = 'committed';"

docker compose -f docker-compose.prod.yml exec -T db psql -U "$USER_ID" -d postgres \
  -c "DROP DATABASE ${DRILL}" >/dev/null

END="$(date +%s)"
echo "[drill] 完成，用时 $((END - START)) 秒（RTO 参考）"
