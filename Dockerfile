FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./

# 安装生产依赖并深度剔除无用跨平台与文档冗余
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --omit=dev --no-audit && \
    rm -rf /root/.npm \
           node_modules/onnxruntime-node/bin/napi-v6/darwin \
           node_modules/onnxruntime-node/bin/napi-v6/win32 \
           node_modules/**/README.md \
           node_modules/**/CHANGELOG.md \
           node_modules/**/.github \
           node_modules/**/test \
           node_modules/**/tests \
           node_modules/**/examples

# -------------------------------------------------------------
# 运行环境：精简至极致 (~75MB 压缩后传输仅约 30MB)
# -------------------------------------------------------------
FROM node:22-bookworm-slim

WORKDIR /app

ENV TZ=Asia/Shanghai \
    PORT=8080 \
    CTYUN_DATA_DIR=/app/data

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# 从构建阶段仅拷贝瘦身后的 node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY app ./app
COPY server.js ./

EXPOSE 8080

VOLUME ["/app/data"]

CMD ["node", "server.js"]
