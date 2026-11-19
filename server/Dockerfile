FROM node:22-alpine

WORKDIR /app

COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server/src ./src
COPY server/migrations ./migrations
COPY server/public ./public

# 复用扩展里已验证的纯领域模块（无 DOM / 无 chrome API）
COPY src/data-core.js ./domain-src/data-core.js
COPY src/identity.js ./domain-src/identity.js
COPY src/analyze.js ./domain-src/analyze.js
COPY src/import-map.js ./domain-src/import-map.js
COPY src/customer-profile.js ./domain-src/customer-profile.js
COPY src/dify.js ./domain-src/dify.js

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "src/index.js"]
