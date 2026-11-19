#!/usr/bin/env bash
# 每日逻辑备份：pg_dump 自定义格式，本地保留 7 天，可选上传阿里云 OSS
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "[backup] 缺少 .env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

OUT_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/ali_cloud_${STAMP}.dump"

docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U "${POSTGRES_USER:-ali}" -d "${POSTGRES_DB:-ali_cloud}" -Fc > "$FILE"

if [ ! -s "$FILE" ]; then
  echo "[backup] 备份文件为空，pg_dump 可能失败" >&2
  rm -f "$FILE"
  exit 1
fi
echo "[backup] 完成 $FILE ($(du -h "$FILE" | cut -f1))"

if command -v ossutil >/dev/null 2>&1 && [ -n "${OSS_BUCKET:-}" ]; then
  ossutil cp -f "$FILE" "oss://${OSS_BUCKET}/${OSS_PREFIX:-db}/$(basename "$FILE")"
  echo "[backup] 已上传 oss://${OSS_BUCKET}/${OSS_PREFIX:-db}/"
else
  echo "[backup] 未配置 ossutil/OSS_BUCKET，本次仅保留本地"
fi

find "$OUT_DIR" -name 'ali_cloud_*.dump' -mtime +7 -delete
echo "[backup] 本地保留 7 天"
