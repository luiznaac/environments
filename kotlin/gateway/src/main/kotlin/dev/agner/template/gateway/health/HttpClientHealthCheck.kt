package dev.agner.template.gateway.health

import dev.agner.template.usecase.commons.now
import dev.agner.template.usecase.health.HealthCheckResult
import dev.agner.template.usecase.health.HealthChecker
import dev.agner.template.usecase.health.HealthGateway
import kotlinx.datetime.LocalDateTime
import org.springframework.stereotype.Service
import java.time.Clock

@Service
class HttpClientHealthCheck(
    private val healthGateway: HealthGateway,
    private val clock: Clock,
) : HealthChecker {

    override suspend fun getHealthStatus() = HealthCheckResult(
        serviceName = "http-client",
        isHealthy = try {
            healthGateway.isHealthy()
        } catch (e: Exception) {
            false
        },
        timestamp = LocalDateTime.now(clock),
    )
}
