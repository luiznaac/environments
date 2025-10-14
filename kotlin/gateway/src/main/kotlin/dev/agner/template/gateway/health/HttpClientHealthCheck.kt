package dev.agner.template.gateway.health

import dev.agner.template.usecase.health.HealthCheckResult
import dev.agner.template.usecase.health.HealthChecker
import dev.agner.template.usecase.health.HealthGateway
import org.springframework.stereotype.Service

@Service
class HttpClientHealthCheck(
    private val healthGateway: HealthGateway,
) : HealthChecker {

    override suspend fun getHealthStatus() = HealthCheckResult(
        serviceName = "http-client",
        isHealthy = healthGateway.isHealthy(),
    )
}
