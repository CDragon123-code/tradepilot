FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
COPY server/collector/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/collector/src ./src

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
