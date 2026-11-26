# Backend build-stage fragment for a project's root image. It is creation-only (declared as
# `instantiate.dockerfile`): creation keeps it out of the lane, and the project's root image
# composes this stage with the chosen stacks' stages and the shared runtime. The COPY paths are
# relative to the project root (`backend/` is python's default lane) and follow that lane; a
# `--lane` override is normalized when the root image is composed.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS backend
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# Resolve dependencies first so a source-only change keeps this layer cached.
COPY backend/pyproject.toml backend/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

COPY backend/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev
# -> /app/.venv and /app/src
