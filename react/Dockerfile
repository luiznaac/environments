# Frontend build-stage fragment for a project's root image. It is creation-only (declared as
# `instantiate.dockerfile`): creation keeps it out of the lane, and the project's root image
# composes this stage with the chosen stacks' stages and the shared runtime. The COPY paths are
# relative to the project root (`frontend/` is react's default lane) and follow that lane; a
# `--lane` override is normalized when the root image is composed.
FROM node:22-slim AS frontend
WORKDIR /fe

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# Served at the nginx root; the API is reached through nginx's /api proxy, so the client's API base
# stays "/api" and the router base stays "/".
ENV VITE_BASE=/ \
    VITE_API_BASE=/api
RUN npm run build
# -> /fe/dist
