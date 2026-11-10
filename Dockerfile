FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/.data NOX_AUTH_DIR=/app/var/auth
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/app.json ./app.json
RUN mkdir -p /app/.data /app/var/auth && chown -R node:node /app/.data /app/var
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "server/index.ts"]
