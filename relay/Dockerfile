# Minimal opaque relay — ADR-0031, issue://80 + issue://81
FROM node:22.18.0-bookworm-slim AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY relay ./relay
WORKDIR /app/relay
RUN npm install && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4318 \
    HOST=0.0.0.0
COPY --from=build /app/relay/package.json ./
COPY --from=build /app/relay/node_modules ./node_modules
COPY --from=build /app/relay/dist ./dist
EXPOSE 4318
# The relay is the piece meant for public hosting, so it must not run as root.
# `node` (UID/GID 1000) ships in the base image; relay state is in memory and
# nothing under /app is written at runtime, so no ownership change is needed.
USER node
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:4318/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
