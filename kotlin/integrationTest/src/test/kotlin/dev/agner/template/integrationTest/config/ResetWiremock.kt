package dev.agner.template.integrationTest.config

import io.kotest.core.extensions.Extension
import io.kotest.core.listeners.AfterTestListener
import io.kotest.core.test.TestCase
import io.kotest.core.test.TestResult

object ResetWiremock : Extension, AfterTestListener {
    override suspend fun afterTest(testCase: TestCase, result: TestResult) {
        HttpMockService.clearMocks()
    }
}
