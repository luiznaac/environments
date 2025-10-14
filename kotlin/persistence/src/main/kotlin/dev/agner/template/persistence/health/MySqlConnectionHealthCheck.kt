package dev.agner.template.persistence.health

import dev.agner.template.usecase.health.HealthCheckResult
import dev.agner.template.usecase.health.HealthChecker
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.TransactionManager
import org.jetbrains.exposed.v1.jdbc.transactions.transaction
import org.springframework.stereotype.Component

@Component
class MySqlConnectionHealthCheck(
    private val database: Database,
) : HealthChecker {

    override suspend fun getHealthStatus() = HealthCheckResult(
        serviceName = "mysql-connection",
        isHealthy = try {
            executeQuery()
            true
        } catch (e: Exception) {
            false
        },
    )

    private fun executeQuery() {
        transaction(database) {
            TransactionManager.current().connection
                .prepareStatement("SELECT 1", true)
                .executeQuery()
        }
    }
}
