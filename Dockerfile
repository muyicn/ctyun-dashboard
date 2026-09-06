FROM node:22-bookworm-slim

WORKDIR /app

ENV TZ=Asia/Shanghai \
    PORT=8080 \
    CTYUN_DATA_DIR=/app/data

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 换用阿里云国内镜像源，仅安装基础系统证书 (彻底拔除 Chromium 依赖，体积骤降 600MB)
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list 2>/dev/null || true && \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY package.json ./

# 配置 npm 国内镜像源，安装纯原生依赖 (仅 jimp 与 onnxruntime-node)
RUN npm config set registry https://registry.npmmirror.com && \
    npm install --production --no-audit && \
    rm -rf /root/.npm \
    node_modules/onnxruntime-node/bin/napi-v6/darwin \
    node_modules/onnxruntime-node/bin/napi-v6/win32

COPY . .

EXPOSE 8080

VOLUME ["/app/data"]

CMD ["node", "server.js"]
