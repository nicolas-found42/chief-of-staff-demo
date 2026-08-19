# Build server + web, drop dev dependencies, then copy the result into a clean
# runtime image. One image: Node serves the API and the built web UI.
FROM node:22-slim AS build
WORKDIR /app

# Manifests first, so `npm ci` is only re-run when dependencies change.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY tests/package.json tests/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
# HOST=0.0.0.0 because the loopback interface inside a container is not
# reachable from the host; the host-side binding stays on 127.0.0.1 (compose).
ENV NODE_ENV=production \
    PORT=4317 \
    HOST=0.0.0.0 \
    WORKSPACE_DIR=/app/workspace

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist

# Runs and secrets live in the mounted workspace, never in a layer.
RUN mkdir -p /app/workspace && chown -R node:node /app/workspace
USER node
VOLUME ["/app/workspace"]
EXPOSE 4317
CMD ["node", "apps/server/dist/main.js"]
