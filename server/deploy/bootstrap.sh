#!/usr/bin/env bash
# 阿里云服务器一键初始化：安装 Docker、生成 .env、构建并启动、健康检查
# 用法（在 /opt/ali-cloud/server/deploy 下，root 执行）：
#   sudo ./bootstrap.sh --domain api.example.com --seller seller-main --with-backup-cron
#   sudo ./bootstrap.sh --ip-mode --with-backup-cron        # 无域名临时访问，https://<公网IP>:8443
set -euo pipefail

DOMAIN=""
SELLER="seller-main"
TENANT="default"
ROOT=""
WITH_CRON=0
IP_MODE=0
PUBLIC_IP=""

usage() {
  cat <<'EOF'
参数：
  --domain <域名>        正式模式必填（首次初始化），例如 api.example.com
  --ip-mode              临时 IP 访问模式：无需域名/备案，监听 8443 自签证书
  --ip <公网IP>          IP 模式下指定公网 IP；不填则自动探测
  --seller <店铺ID>      默认 seller-main
  --tenant <租户ID>      默认 default
  --root <项目根目录>    默认自动推断（deploy 的上两级）
  --with-backup-cron     安装每日 03:00 备份的 crontab
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --seller) SELLER="$2"; shift 2 ;;
    --tenant) TENANT="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --ip-mode) IP_MODE=1; shift ;;
    --ip) PUBLIC_IP="$2"; shift 2 ;;
    --with-backup-cron) WITH_CRON=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage; exit 1 ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 或 sudo 运行：sudo $0 $*" >&2
  exit 1
fi

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${ROOT:-$(cd "${DEPLOY_DIR}/../.." && pwd)}"
cd "${DEPLOY_DIR}"

COMPOSE=(docker compose -f docker-compose.prod.yml)
if [[ "${IP_MODE}" -eq 1 ]]; then
  COMPOSE+=(-f docker-compose.ip.yml)
fi

echo "[1/5] 检查目录"
for f in "${ROOT}/server/Dockerfile" "${ROOT}/src/data-core.js" "${DEPLOY_DIR}/docker-compose.prod.yml"; do
  [[ -f "$f" ]] || { echo "缺少文件：$f（请确认已上传 server 与 src）" >&2; exit 1; }
done
if [[ "${IP_MODE}" -eq 1 ]]; then
  for f in "${DEPLOY_DIR}/docker-compose.ip.yml" "${DEPLOY_DIR}/Caddyfile.ip"; do
    [[ -f "$f" ]] || { echo "IP 模式缺少文件：$f" >&2; exit 1; }
  done
fi

echo "[2/5] 安装 Docker（已安装则跳过）"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl openssl
  apt-get install -y docker.io || true
fi
systemctl enable --now docker >/dev/null 2>&1 || true
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin || true
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose 插件未就绪，请参考 deploy/README.md 手动安装后重试" >&2
  exit 1
fi

echo "[3/5] 准备环境变量"
if [[ "${IP_MODE}" -eq 1 ]]; then
  if [[ -z "${PUBLIC_IP}" ]]; then
    PUBLIC_IP="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)"
  fi
  if [[ -z "${PUBLIC_IP}" ]]; then
    echo "IP 模式需要 --ip <公网IP>（自动探测失败）" >&2
    exit 1
  fi
  DOMAIN="${PUBLIC_IP}"
fi
if [[ ! -f .env ]]; then
  if [[ -z "${DOMAIN}" ]]; then
    echo "首次初始化必须提供 --domain，或使用 --ip-mode" >&2
    exit 1
  fi
  PASSWORD="$(openssl rand -hex 16)"
  INGEST="$(openssl rand -hex 32)"
  READ="$(openssl rand -hex 32)"
  SECRET="$(openssl rand -hex 32)"
  cp .env.production.example .env
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PASSWORD}|" .env
  sed -i "s|^INGEST_TOKEN=.*|INGEST_TOKEN=${INGEST}|" .env
  sed -i "s|^READ_TOKEN=.*|READ_TOKEN=${READ}|" .env
  sed -i "s|^SECRET_KEY=.*|SECRET_KEY=${SECRET}|" .env
  sed -i "s|^SELLER_ID=.*|SELLER_ID=${SELLER}|" .env
  sed -i "s|^TENANT_ID=.*|TENANT_ID=${TENANT}|" .env
  chmod 600 .env
  echo "[init] 已生成 .env（密码与 Token 为随机值）"
else
  echo "[init] 复用已有 .env"
fi
mkdir -p backups logs
chmod +x backup.sh restore-drill.sh 2>/dev/null || true

echo "[4/5] 构建并启动"
"${COMPOSE[@]}" up -d --build

echo "[5/5] 健康检查"
ok=0
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T api node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done

if [[ "${WITH_CRON}" -eq 1 ]]; then
  LINE="0 3 * * * cd ${DEPLOY_DIR} && ./backup.sh >> ./logs/backup.log 2>&1"
  ALERT="0 9 * * * docker exec ali-cloud-api-1 node src/alert-cli.js >> ${DEPLOY_DIR}/logs/alert.log 2>&1"
  for ITEM in "${LINE}" "${ALERT}"; do
    if ! crontab -l 2>/dev/null | grep -F "${ITEM}" >/dev/null; then
      { crontab -l 2>/dev/null || true; echo "${ITEM}"; } | crontab -
      echo "[cron] 已安装：${ITEM}"
    else
      echo "[cron] 已存在：${ITEM}"
    fi
  done
fi

CERT_DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2-)"
if [[ "${IP_MODE}" -eq 1 ]]; then
  ACCESS_URL="https://${CERT_DOMAIN}:8443/"
else
  ACCESS_URL="https://${CERT_DOMAIN}/"
fi
echo
if [[ "${ok}" -eq 1 ]]; then
  echo "服务已启动："
else
  echo "服务已启动，但健康检查未通过，请查看：${COMPOSE[*]} logs --tail=100 api" >&2
fi
echo "  访问地址：${ACCESS_URL}"
echo "  采集令牌：$(grep '^INGEST_TOKEN=' .env | cut -d= -f2-)（只填在扩展里）"
echo "  只读令牌：$(grep '^READ_TOKEN=' .env | cut -d= -f2-)（工作台登录用）"
echo "  店铺 ID ：$(grep '^SELLER_ID=' .env | cut -d= -f2-)"
echo
echo "下一步："
if [[ "${IP_MODE}" -eq 1 ]]; then
  echo "  1) 云防火墙放行 8443（建议限制来源 IP），浏览器首次访问需信任自签证书"
  echo "  2) 这是临时访问方式；域名备案通过后改用 --domain 模式"
  echo "  3) 扩展设置页填写 ${ACCESS_URL} 与上面的采集令牌，点「上传现有资料库」"
else
  echo "  1) 确认域名 A 记录指向本机公网 IP，80/443 已在防火墙放行"
  echo "  2) 查看证书：${COMPOSE[*]} logs --tail=50 caddy"
  echo "  3) 扩展设置页填写 ${ACCESS_URL} 与上面的采集令牌，点「上传现有资料库」"
fi
