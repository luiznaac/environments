import java.util.concurrent.TimeUnit

dependencies {
    testImplementation(project(":application"))
    // MigrationSchemaTest uses :persistence's `allTables` directly; persistence declares it as
    // `implementation`, so the edge is explicit rather than transitive.
    testImplementation(project(":persistence"))
    testImplementation(project(":http-api"))
    testImplementation(project(":gateway"))
    testImplementation(project(":usecase"))
    testImplementation(libs.bundles.testDependencies)
    testImplementation(libs.kotest.extensions.spring)
    testImplementation(libs.ktor.client.core)
    testImplementation(libs.spring.boot.starter.test)
    testImplementation(libs.testcontainers)
    testImplementation(libs.wiremock)
    implementation(libs.jackson.kotlin)
    // Same reason: the test calls Database.connect/transaction/MigrationUtils directly.
    testImplementation(libs.exposed.core)
    testImplementation(libs.exposed.jdbc)
    testImplementation(libs.exposed.migration.core)
    testImplementation(libs.exposed.migration.jdbc)
}

// Testcontainers only discovers an unreachable daemon once a spec's first container starts, which
// surfaces as an opaque DockerClientProviderStrategy error buried in the HTML report. Probe the
// daemon first so the whole integration lane fails in seconds with a message that says what to do.
val dockerPreflight by tasks.registering {
    group = "verification"
    description = "Fails fast, with an actionable message, when the Docker daemon is unavailable."

    doLast {
        fun dockerUnavailable(reason: String, detail: String = "", cause: Throwable? = null): Nothing =
            throw GradleException(
                """
                The integration tests need $reason
                Start Docker and retry, or run the Docker-free lane: ./gradlew unitTest --no-daemon
                $detail
                """.trimIndent(),
                cause,
            )

        val process = try {
            ProcessBuilder("docker", "info").redirectErrorStream(true).start()
        } catch (exception: java.io.IOException) {
            dockerUnavailable("Docker, but the `docker` CLI is not on PATH.", cause = exception)
        }
        // A wedged daemon would otherwise hang the preflight itself — the failure mode this task
        // exists to cut short.
        val finished = process.waitFor(30, TimeUnit.SECONDS)
        if (!finished) {
            process.destroyForcibly()
        }
        val output = process.inputStream.bufferedReader().use { it.readText() }
        val exitCode = if (finished) process.exitValue() else null
        if (exitCode != 0) {
            val detail = output.lines()
                .filter { it.contains("error", ignoreCase = true) }
                .take(3)
                .ifEmpty { output.trim().lines().takeLast(3) }
                .joinToString("\n")
            dockerUnavailable(
                reason = if (exitCode == null) {
                    "a running Docker daemon, but `docker info` did not return in 30s."
                } else {
                    "a running Docker daemon, but `docker info` exited $exitCode."
                },
                detail = detail,
            )
        }
    }
}

tasks.test {
    dependsOn(dockerPreflight)
}
