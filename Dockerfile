FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./

# 安装纯净精简生产依赖 (仅需原生 ws 协议库，彻底剔除 C++ 二进制 ONNX/图像框架)
RUN npm config set registry https://registry.npmmirror.com && \
    npm install --omit=dev --no-audit && \
    rm -rf /root/.npm \
           node_modules/**/README.md \
           node_modules/**/CHANGELOG.md \
           node_modules/**/.github \
           node_modules/**/test \
           node_modules/**/tests \
           node_modules/**/examples

# -------------------------------------------------------------
# 运行环境：精简至极致 (压缩后传输仅约 20MB)
# -------------------------------------------------------------
FROM node:22-bookworm-slim

WORKDIR /app

ENV TZ=Asia/Shanghai \
    PORT=8571 \
    CTYUN_DATA_DIR=/app/data

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# 从构建阶段拷贝极速轻量 node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY app ./app
COPY server.js ./

EXPOSE 8571

VOLUME ["/app/data"]

CMD ["node", "server.js"]
