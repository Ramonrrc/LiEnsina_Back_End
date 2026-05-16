FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS production

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV DATABASE_DRIVER=postgres
ENV DATABASE_PATH=/app/data/liensina.sqlite
ENV JWT_ACCESS_EXPIRES_IN=30m
ENV REFRESH_TOKEN_DAYS=7
ENV REFRESH_TOKEN_REUSE_GRACE_SECONDS=15

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY scripts ./scripts

RUN mkdir -p /app/data /app/uploads && chown -R node:node /app
USER node

EXPOSE 3001

CMD ["node", "dist/main.js"]
