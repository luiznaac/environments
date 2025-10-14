package dev.agner.template.integrationTest.config

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
import org.testcontainers.containers.ComposeContainer
import org.testcontainers.containers.wait.strategy.Wait
import java.io.File

object DockerComposeExtension : Extension, BeforeProjectListener, AfterProjectListener, AfterTestListener {
    override suspend fun beforeProject() {
        DockerCompose.start()
    }

    override suspend fun afterProject() {
        DockerCompose.stop()
    }

    override suspend fun afterTest(testCase: TestCase, result: TestResult) {
        withContext(Dispatchers.IO) {
            launch {
                DockerCompose.getContainerByServiceName("mysql-1")
                    .get()
                    .execInContainer(
                        "bash",
                        "-c",
                        """
                            mysql -uroot -Nse 'show tables' template | while read table; do
                               if [ "${'$'}table" != 'index' ]; then
                                   mysql -e "set FOREIGN_KEY_CHECKS=0; truncate table ${'$'}table" template;
                               fi
                            done
                        """.trimIndent(),
                    )
                    .exitCode shouldBe 0
            }
        }.join()
    }
}

object DockerCompose : ComposeContainer(
    File("../docker-compose.yml").canonicalFile,
) {
    init {
        withLocalCompose(true)
        withBuild(true)
        withExposedService("mysql", 3306, Wait.forListeningPort())
    }
}
