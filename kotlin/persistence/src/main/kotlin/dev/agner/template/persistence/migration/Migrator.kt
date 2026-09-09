package dev.agner.template.persistence.migration

import org.flywaydb.core.Flyway
import org.flywaydb.core.api.Location

object MysqlEnv {
    val host = System.getenv("MYSQL_HOST") ?: "localhost"
    val user = System.getenv("MYSQL_USER") ?: "root"
    val password = System.getenv("MYSQL_PASSWORD") ?: ""
    val database = System.getenv("MYSQL_DATABASE") ?: "template"
}

fun main() {
    val flyway = Flyway.configure()
        .dataSource("jdbc:mysql://${MysqlEnv.host}/$${MysqlEnv.database}", MysqlEnv.user, MysqlEnv.password)
        .baselineOnMigrate(true)
        .baselineVersion("1")
        .locations(Location("classpath:db/migration"))
        .load()

    flyway.migrate()
}
