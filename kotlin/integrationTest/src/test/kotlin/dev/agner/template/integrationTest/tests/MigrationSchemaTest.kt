package dev.agner.template.integrationTest.tests

import dev.agner.template.persistence.migration.allTables
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import org.jetbrains.exposed.v1.core.ExperimentalDatabaseMigrationApi
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.transaction
import org.jetbrains.exposed.v1.migration.jdbc.MigrationUtils

// The guard that keeps db/migration/ and the Exposed tables from drifting apart.
// DockerComposeExtension migrates the compose-provided MySQL to head before any spec runs; this
// asks Exposed what would still have to change for it to match `allTables`. Anything non-empty
// means someone edited a *Table without writing the migration, or vice versa.
@OptIn(ExperimentalDatabaseMigrationApi::class)
class MigrationSchemaTest : StringSpec({

    "schema should match Exposed table definitions" {
        val db = Database.connect(
            url = "jdbc:mysql://localhost:3306/template",
            driver = "com.mysql.cj.jdbc.Driver",
            user = "root",
            password = "",
        )
        transaction(db) {
            val statementsRequired = MigrationUtils.statementsRequiredForDatabaseMigration(
                *allTables.toTypedArray(),
            )
            statementsRequired shouldBe emptyList()
        }
    }
})
