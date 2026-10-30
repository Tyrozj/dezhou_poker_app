# 德扑云桌 —— 生产/托管用镜像（零依赖，镜像很小）
FROM node:22-alpine

WORKDIR /app

# 只复制运行所需文件，不需要 npm install
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY web ./web

ENV PORT=18080 \
    DATA_DIR=/data \
    NODE_ENV=production

# 房间表 / 战绩表落在这里，挂载卷可长期保留战绩
VOLUME ["/data"]
EXPOSE 18080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "server/index.mjs"]
