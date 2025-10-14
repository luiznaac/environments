package dev.agner.template.usecase.health

interface HealthGateway {
    suspend fun isHealthy(): Boolean
}
