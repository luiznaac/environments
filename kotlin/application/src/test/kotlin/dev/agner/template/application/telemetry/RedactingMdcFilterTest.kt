package dev.agner.template.application.telemetry

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.LoggerContext
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import dev.agner.template.usecase.commons.TelemetryAttributes
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.maps.shouldContain
import io.kotest.matchers.maps.shouldNotContainKey
import io.kotest.matchers.shouldBe
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.logs.Severity
import io.opentelemetry.instrumentation.api.config.IncludeExclude
import io.opentelemetry.instrumentation.logback.appender.v1_0.OpenTelemetryAppender
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.logs.SdkLoggerProvider
import io.opentelemetry.sdk.logs.export.SimpleLogRecordProcessor
import io.opentelemetry.sdk.testing.exporter.InMemoryLogRecordExporter
import org.slf4j.LoggerFactory
import org.slf4j.MDC

class RedactingMdcFilterTest : StringSpec({

    lateinit var context: LoggerContext
    lateinit var logger: Logger
    lateinit var events: ListAppender<ILoggingEvent>
    lateinit var filter: RedactingMdcFilter

    beforeTest {
        context = LoggerFactory.getILoggerFactory() as LoggerContext
        logger = context.getLogger("redaction-test")
        logger.level = Level.INFO
        events = ListAppender()
        events.context = context
        events.start()
        logger.addAppender(events)
        filter = RedactingMdcFilter().apply {
            this.context = context
            start()
        }
        context.addTurboFilter(filter)
    }

    afterTest {
        logger.detachAppender(events)
        context.turboFilterList.remove(filter)
        MDC.clear()
    }

    "redacts a scalar secret by key and keeps the key visible" {
        MDC.put("authorization", "Bearer top-secret")
        MDC.put("order.id", "42")

        logger.info("plain message")

        val rendered = events.list.single().mdcPropertyMap
        rendered shouldContain ("authorization" to Redaction.REDACTED)
        rendered shouldContain ("order.id" to "42")
        MDC.get("authorization") shouldBe Redaction.REDACTED
    }

    "drops a secret-bearing container and any body" {
        MDC.put("api.key", "{\"credential\":\"top-secret\"}")
        MDC.put("request.body", "{\"password\":\"top-secret\"}")

        logger.info("plain message")

        val rendered = events.list.single().mdcPropertyMap
        rendered.shouldNotContainKey("api.key")
        rendered.shouldNotContainKey("request.body")
    }

    "leaves non-secret PII alone" {
        MDC.put("user.email", "someone@example.com")

        logger.info("plain message")

        events.list.single().mdcPropertyMap shouldContain ("user.email" to "someone@example.com")
    }

    "the OTLP rendering is redacted by the same chokepoint" {
        val exporter = InMemoryLogRecordExporter.create()
        val sdk = OpenTelemetrySdk.builder()
            .setLoggerProvider(
                SdkLoggerProvider.builder()
                    .addLogRecordProcessor(SimpleLogRecordProcessor.create(exporter))
                    .build(),
            )
            .build()
        OpenTelemetryAppender.install(sdk)
        val appender = OpenTelemetryAppender().apply {
            this.context = context
            setOpenTelemetry(sdk)
            setMdcAttributes(IncludeExclude.builder().setIncluded("*").build())
            start()
        }
        logger.addAppender(appender)

        MDC.put("password", "top-secret")
        MDC.put(TelemetryAttributes.REQUEST_ID, "request-12345678")

        logger.info("orders.failed")

        val record = exporter.finishedLogRecordItems.single()
        record.attributes.get(AttributeKey.stringKey("password")) shouldBe Redaction.REDACTED
        record.attributes.get(AttributeKey.stringKey(TelemetryAttributes.REQUEST_ID)) shouldBe "request-12345678"
        record.severityText shouldBe "INFO"
        record.severity shouldBe Severity.INFO
        record.spanContext.isValid shouldBe false

        logger.detachAppender(appender)
    }

    "the redaction map never carries the secret value in either rendering" {
        val redacted = Redaction.redact(mapOf("cookie" to "session=abc", "http.request.body" to "{\"a\":1}"))

        redacted shouldBe mapOf("cookie" to Redaction.REDACTED)
        redacted.values shouldNotContain "session=abc"
    }
})
