package dev.agner.template.integrationTest.tests

import dev.agner.template.persistence.migration.allTables
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction

class MigrationSchemaTest : IntegrationTest() {
    init {
        "schema should match Exposed table definitions" {
            transaction(db) {
                // The schema should be fully migrated at this point via docker-compose
                // This test asserts that Exposed's in-memory table definitions match
                // what Flyway actually created in the database.
                val statementsRequired = SchemaUtils.statementsRequiredForDatabaseMigration(*allTables.toTypedArray())
                statementsRequired shouldBe emptyList()
            }
        }
    }
}
