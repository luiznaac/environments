package dev.agner.template.integrationTest.config

import dev.agner.template.persistence.migration.migrate
import io.kotest.core.extensions.Extension
import io.kotest.core.listeners.AfterProjectListener
import io.kotest.core.listeners.AfterTestListener
import io.kotest.core.listeners.BeforeProjectListener
import io.kotest.core.test.TestCase
import io.kotest.core.test.TestResult
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.testcontainers.containers.MySQLContainer
import java.net.ServerSocket

// One MySQL container and one app port per test JVM, so two concurrent suite runs never contend for
// a host port. The container is started before any spec and the coordinates it exposes are published
// as system properties — which outrank application.yaml — so DatabaseConfig, KtorConfig and
// AppHealthGateway follow the harness without a code change.
object MySqlContainerExtension : Extension, BeforeProjectListener, AfterProjectListener, AfterTestListener {

    override suspend fun beforeProject() {
        TestMySql.start()
        publishCoordinates()
        // The container starts empty — db/migration/V*.sql is applied by Flyway, not by an init
        // script — so migrate it to head before any spec boots the Spring context.
        migrate(
            host = TestMySql.host,
            port = TestMySql.mappedPort,
            user = TestMySql.username,
            password = TestMySql.password,
            database = TestMySql.databaseName,
        )
    }

    override suspend fun afterProject() {
        TestMySql.stop()
    }

    override suspend fun afterTest(testCase: TestCase, result: TestResult) {
        val user = TestMySql.username
        val database = TestMySql.databaseName
        withContext(Dispatchers.IO) {
            launch {
                TestMySql.execInContainer(
                    "bash",
                    "-c",
                    """
                        mysql -u$user -Nse 'show tables' $database | while read table; do
                           if [ "${'$'}table" != 'flyway_schema_history' ]; then
                               mysql -e "set FOREIGN_KEY_CHECKS=0; truncate table ${'$'}table" $database;
                           fi
                        done
                    """.trimIndent(),
                ).exitCode shouldBe 0
            }
        }.join()
    }

    private fun publishCoordinates() {
        System.setProperty("mysql.host", TestMySql.host)
        System.setProperty("mysql.port", TestMySql.mappedPort.toString())
        System.setProperty("mysql.user", TestMySql.username)
        System.setProperty("mysql.password", TestMySql.password)
        System.setProperty("mysql.database", TestMySql.databaseName)
        System.setProperty("ktor.port", freePort().toString())
    }
}

internal class MySqlTestContainer : MySQLContainer<MySqlTestContainer>("mysql:9.4.0") {
    init {
        withDatabaseName("template")
        withUsername("root")
        withPassword("")
        // testcontainers-java's bundled my.cnf still sets innodb_log_file_size, removed in MySQL
        // 8.0.30+ and rejected by mysql:9.4.0, so the container refuses to start without this
        // override. The file is empty on purpose: see src/test/resources/mysql-test-conf/my.cnf.
        withConfigurationOverride("mysql-test-conf")
    }
}

internal val TestMySql = MySqlTestContainer()

internal val MySqlTestContainer.mappedPort: Int
    get() = getMappedPort(MySQLContainer.MYSQL_PORT)

// Probe-then-rebind has a millisecond-wide TOCTOU window; Testcontainers itself relies on
// OS-assigned ports the same way. The OS ephemeral range is disjoint from the dev block range.
private fun freePort() = ServerSocket(0).use { it.localPort }
