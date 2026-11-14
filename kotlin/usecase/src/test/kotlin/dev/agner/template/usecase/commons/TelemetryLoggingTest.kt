package dev.agner.template.usecase.commons

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.LoggerContext
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.slf4j.LoggerFactory
import org.slf4j.MDC

class TelemetryLoggingTest : StringSpec({

    lateinit var logger: Logger
    lateinit var events: ListAppender<ILoggingEvent>

    beforeTest {
        val context = LoggerFactory.getILoggerFactory() as LoggerContext
        logger = context.getLogger("telemetry-logging-test")
        events = ListAppender()
        events.context = context
        events.start()
        logger.addAppender(events)
        logger.level = Level.DEBUG
    }

    afterTest {
        logger.detachAppender(events)
        MDC.clear()
    }

    "logs the event name as the body and stamps event.name as an attribute" {
        logger.event("orders.created", "order.id" to 42)

        val event = events.list.single()
        event.message shouldBe "orders.created"
        event.level shouldBe Level.INFO
        event.mdcPropertyMap[TelemetryAttributes.EVENT_NAME] shouldBe "orders.created"
        event.mdcPropertyMap["order.id"] shouldBe "42"
    }

    "clears the event scope synchronously after the call" {
        logger.event("orders.created", "order.id" to 42, throwable = null)

        MDC.get(TelemetryAttributes.EVENT_NAME) shouldBe null
        MDC.get("order.id") shouldBe null
    }

    "keeps the event scope across a coroutine dispatch" {
        runTest {
            withContext(Dispatchers.Default) {
                logger.event("db.migration.applied", "db.migration.version" to 3)
            }
        }

        val event = events.list.single()
        event.mdcPropertyMap[TelemetryAttributes.EVENT_NAME] shouldBe "db.migration.applied"
        event.mdcPropertyMap["db.migration.version"] shouldBe "3"
    }

    "maps the requested level onto the record" {
        logger.event("http.request.failed", level = EventLevel.WARN)
        logger.event("orders.failed", level = EventLevel.ERROR)
        logger.event("db.query.slow", level = EventLevel.DEBUG)

        events.list.map { it.level } shouldBe listOf(Level.WARN, Level.ERROR, Level.DEBUG)
    }

    "carries the throwable on an ERROR record" {
        val failure = IllegalStateException("boom")

        logger.event("http.request.failed", level = EventLevel.ERROR, throwable = failure)

        val event = events.list.single()
        event.level shouldBe Level.ERROR
        event.throwableProxy.shouldNotBeNull().className shouldBe "java.lang.IllegalStateException"
    }

    "keeps a plain info call as a body-only diagnostic" {
        logger.info("route table initialized")

        events.list.single().message shouldBe "route table initialized"
        (MDC.getCopyOfContextMap() ?: emptyMap()).keys.shouldBeEmpty()
    }
})
