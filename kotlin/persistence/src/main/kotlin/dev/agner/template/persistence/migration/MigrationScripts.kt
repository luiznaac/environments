package dev.agner.template.persistence.migration

import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.datetime.datetime

object HealthCheckLogTable : Table("health_check_log") {
    val id = integer("id").autoIncrement()
    val checkName = varchar("check_name", 255)
    val isHealthy = bool("is_healthy")
    val checkedAt = datetime("checked_at")
    val message = varchar("message", 500).nullable()

    override val primaryKey = PrimaryKey(id)
}

val allTables = listOf(HealthCheckLogTable)
