package dev.agner.template.usecase.health

import java.time.Instant

data class HealthCheckResult(
    val serviceName: String,
    val isHealthy: Boolean,
    val timestamp: Instant = Instant.now(),
)
