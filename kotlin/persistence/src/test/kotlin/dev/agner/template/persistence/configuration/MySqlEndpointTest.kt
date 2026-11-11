package dev.agner.template.persistence.configuration

import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

class MySqlEndpointTest : StringSpec({

    "resolves the configured port from the environment value" {
        resolveMysqlPort("8112") shouldBe 8112
    }

    "falls back to the canonical MySQL port when the environment value is absent" {
        resolveMysqlPort(null) shouldBe 3306
    }

    "falls back to the canonical MySQL port when the environment value is not a number" {
        resolveMysqlPort("not-a-port") shouldBe 3306
    }

    "builds the JDBC URL from the configured port instead of a hardcoded one" {
        mysqlJdbcUrl(host = "db", port = 8112, database = "widget") shouldBe
            "jdbc:mysql://db:8112/widget"
    }
})
