package dev.agner.template.persistence.migration

import org.flywaydb.core.Flyway
import org.flywaydb.core.api.Location

object MysqlEnv {
    val host = System.getenv("MYSQL_HOST") ?: "localhost"
    val user = System.getenv("MYSQL_USER") ?: "root"
    val password = System.getenv("MYSQL_PASSWORD") ?: ""
    val database = System.getenv("MYSQL_DATABASE") ?: "template"
}

// Applies every pending db/migration/V*.sql. Called from DockerComposeExtension so the
// integration suite runs against a migrated database, and by `main` for local/deploy use — never
// from the Spring context: KtorConfig blocks the main thread for the process's entire lifetime,
// so a Spring-context hook would never run before the server starts serving traffic anyway. A
// failed migration aborts the container instead of leaving a half-migrated app answering
// requests.

fun migrate(host: String, user: String, password: String, database: String) {
    Flyway.configure()
        .dataSource("jdbc:mysql://$host:3306/$database", user, password)
        .baselineOnMigrate(true)
        .baselineVersion("1")
        .locations(Location("classpath:db/migration"))
        .load()
        .migrate()
}

fun main() {
    migrate(MysqlEnv.host, MysqlEnv.user, MysqlEnv.password, MysqlEnv.database)
}
