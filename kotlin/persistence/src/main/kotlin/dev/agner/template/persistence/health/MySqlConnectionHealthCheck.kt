package dev.agner.template.persistence.health

import dev.agner.template.usecase.commons.now
import dev.agner.template.usecase.health.HealthCheckResult
import dev.agner.template.usecase.health.HealthChecker
import kotlinx.datetime.LocalDateTime
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.TransactionManager
import org.jetbrains.exposed.v1.jdbc.transactions.transaction
import org.springframework.stereotype.Component
import java.time.Clock

@Component
class MySqlConnectionHealthCheck(
    private val database: Database,
    private val clock: Clock,
) : HealthChecker {

    override suspend fun getHealthStatus() = HealthCheckResult(
        serviceName = "mysql-connection",
        isHealthy = try {
            executeQuery()
            true
        } catch (e: Exception) {
            false
        },
        timestamp = LocalDateTime.now(clock),
    )

    private fun executeQuery() {
        transaction(database) {
            TransactionManager.current().connection
                .prepareStatement("SELECT 1", true)
                .executeQuery()
        }
    }
}
