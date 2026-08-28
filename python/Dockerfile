# syntax=docker/dockerfile:1

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS build
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev


FROM python:3.12-slim-bookworm
WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1
COPY --from=build /app /app

EXPOSE 8080
CMD ["uvicorn", "template.application.boot:app", "--host", "0.0.0.0", "--port", "8080"]
