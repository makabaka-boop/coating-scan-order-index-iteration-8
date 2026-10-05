# 前端静态页面镜像：多阶段构建，产物为纯静态文件
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:80/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
