#!/bin/sh
# Entrypoint for a paired root image: start the backend in the background, then hand the
# foreground to nginx. `APP_CMD` is the backend start command the composition embeds from the
# backend stack's `instantiate.runtime.command`.
set -e

if [ -z "${APP_CMD}" ]; then
  echo "APP_CMD is not set — the paired runtime expects the backend start command" >&2
  exit 1
fi

sh -c "${APP_CMD}" &
exec nginx -g 'daemon off;'
