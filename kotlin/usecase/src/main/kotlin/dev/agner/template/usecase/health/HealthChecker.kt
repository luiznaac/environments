package dev.agner.template.usecase.health

interface HealthChecker {

    suspend fun getHealthStatus(): HealthCheckResult
}
