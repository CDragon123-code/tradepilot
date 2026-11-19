#!/usr/bin/env bash
for m in docker.m.daocloud.io docker.1ms.run docker.xuanyuan.me hub.rat.dev dockerproxy.net mirror.ccs.tencentyun.com; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$m/v2/" || echo ERR)
  echo "$m $code"
done
