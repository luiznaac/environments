package dev.agner.template.persistence.configuration

internal const val DEFAULT_MYSQL_PORT = 3306

// The port a standalone run (the Flyway `main`, the integration harness) resolves from the
// environment, with the canonical MySQL port as the fallback when the value is absent or not a
// number. The Spring path reads `${mysql.port}` from application.yaml instead.
internal fun resolveMysqlPort(raw: String?) = raw?.toIntOrNull() ?: DEFAULT_MYSQL_PORT

// The one place a JDBC URL is built, so the port a run resolves is the port it connects to.
internal fun mysqlJdbcUrl(host: String, port: Int, database: String) = "jdbc:mysql://$host:$port/$database"
