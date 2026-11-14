package dev.agner.template.usecase.commons

import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldMatch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.slf4j.MDC

class RequestContextTest : StringSpec({

    afterTest {
        MDC.clear()
    }

    "keeps a valid inbound request id" {
        RequestContext.resolve("client-request-id-123").requestId shouldBe "client-request-id-123"
    }

    "replaces a too-short inbound id with a generated canonical UUIDv4" {
        RequestContext.resolve("short").requestId shouldMatch RequestContext.GENERATED_REQUEST_ID
    }

    "replaces an inbound id carrying invalid characters" {
        RequestContext.resolve("not a valid id!!").requestId shouldMatch RequestContext.GENERATED_REQUEST_ID
    }

    "replaces an over-long inbound id" {
        RequestContext.resolve("a".repeat(129)).requestId shouldMatch RequestContext.GENERATED_REQUEST_ID
    }

    "binds request.id into MDC across a coroutine dispatch" {
        val context = RequestContext(requestId = "request-12345678")

        runTest {
            withContext(Dispatchers.Default + context) {
                MDC.get(TelemetryAttributes.REQUEST_ID) shouldBe "request-12345678"
            }
        }

        MDC.get(TelemetryAttributes.REQUEST_ID).shouldBeNull()
    }
})
