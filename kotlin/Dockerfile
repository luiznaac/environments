# Backend build-stage fragment for a project's root image. It is creation-only (declared as
# `instantiate.dockerfile`): creation keeps it out of the lane, and the project's root image
# composes this stage with the chosen stacks' stages and the shared runtime. The COPY paths are
# relative to the project root (`backend/` is kotlin's default lane) and follow that lane; a
# `--lane` override is normalized when the root image is composed.
FROM eclipse-temurin:21-jdk AS backend
WORKDIR /app

COPY backend/ ./
# A Windows checkout (core.autocrlf=true) can introduce CRLF, which breaks the wrapper's shebang
# inside the Linux build; normalize it before running Gradle.
RUN sed -i 's/\r$//' gradlew && chmod +x gradlew
RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew --no-daemon :application:installDist
# -> /app/application/build/install/application/{bin,lib}
