FROM node:22-bookworm-slim

WORKDIR /app

ENV TZ=Asia/Shanghai \
    PORT=8080 \
    CTYUN_DATA_DIR=/app/data \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 仅安装无头浏览器 Chromium、中文字体与必要证书，完成后清理 apt 缓存
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-wqy-microhei \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY package.json ./

# 安装纯生产依赖并清理非 Linux 二进制包进一步缩减镜像体积
RUN npm install --production --no-audit && \
    rm -rf /root/.npm \
    node_modules/onnxruntime-node/bin/napi-v6/darwin \
    node_modules/onnxruntime-node/bin/napi-v6/win32

COPY . .

EXPOSE 8080

VOLUME ["/app/data"]

CMD ["node", "server.js"]
