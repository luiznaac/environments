package dev.agner.template.integrationTest.config

import dev.agner.template.application.Boot
import io.kotest.core.annotation.Isolate
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.ActiveProfiles
import org.springframework.test.context.TestExecutionListeners

@SpringBootTest(classes = [Boot::class])
@ActiveProfiles("test")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_EACH_TEST_METHOD)
@TestExecutionListeners(
    value = [StopKtorServer::class],
    mergeMode = TestExecutionListeners.MergeMode.MERGE_WITH_DEFAULTS,
)
@Isolate
annotation class IntegrationTest
