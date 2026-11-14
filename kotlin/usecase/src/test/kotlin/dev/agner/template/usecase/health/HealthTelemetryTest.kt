package dev.agner.template.usecase.health

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.LoggerContext
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import dev.agner.template.usecase.commons.MetricCatalog
import dev.agner.template.usecase.commons.TelemetryAttributes
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.metrics.data.MetricData
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import kotlinx.datetime.LocalDateTime
import org.slf4j.LoggerFactory

private val componentKey = AttributeKey.stringKey(TelemetryAttributes.HEALTH_COMPONENT)
private val errorTypeKey = AttributeKey.stringKey(TelemetryAttributes.ERROR_TYPE)

class HealthTelemetryTest : StringSpec({

    lateinit var reader: InMemoryMetricReader
    lateinit var telemetry: HealthTelemetry
    lateinit var logger: Logger
    lateinit var events: ListAppender<ILoggingEvent>

    beforeTest {
        val metricReader = InMemoryMetricReader.create()
        reader = metricReader
        val sdk = OpenTelemetrySdk.builder()
            .setMeterProvider(SdkMeterProvider.builder().registerMetricReader(metricReader).build())
            .build()
        telemetry = HealthTelemetry(sdk.meterBuilder("test-service").build())

        val context = LoggerFactory.getILoggerFactory() as LoggerContext
        logger = context.getLogger(HealthTelemetry::class.java)
        events = ListAppender()
        events.context = context
        events.start()
        logger.addAppender(events)
    }

    afterTest {
        logger.detachAppender(events)
    }

    "reports the last observed status per component as a 0/1 gauge" {
        telemetry.record(result("mysql-connection", isHealthy = true))
        telemetry.record(result("app-health", isHealthy = false))

        gaugeValues(reader) shouldBe mapOf("mysql-connection" to 1L, "app-health" to 0L)

        telemetry.record(result("mysql-connection", isHealthy = false))

        gaugeValues(reader) shouldBe mapOf("mysql-connection" to 0L, "app-health" to 0L)
    }

    "increments the failure counter once per failed check with the component and error type" {
        telemetry.record(result("mysql-connection", isHealthy = false))
        telemetry.record(result("mysql-connection", isHealthy = false))

        val counter = metric(reader, MetricCatalog.HEALTH_FAILURES)
        counter.unit shouldBe MetricCatalog.CHECKS
        val points = counter.longSumData.points.single()
        points.value shouldBe 2L
        points.attributes.get(componentKey) shouldBe "mysql-connection"
        points.attributes.get(errorTypeKey) shouldBe HealthTelemetry.FAILURE_ERROR_TYPE
    }

    "logs one WARN on the healthy-to-unhealthy transition and one INFO on recovery" {
        telemetry.record(result("mysql-connection", isHealthy = true))
        telemetry.record(result("mysql-connection", isHealthy = false))
        telemetry.record(result("mysql-connection", isHealthy = false))
        telemetry.record(result("mysql-connection", isHealthy = true))

        events.list.map { it.level to it.message } shouldBe listOf(
            Level.WARN to "health.check.failed",
            Level.INFO to "health.check.recovered",
        )
        events.list.first().mdcPropertyMap[TelemetryAttributes.HEALTH_COMPONENT] shouldBe "mysql-connection"
    }

    "never logs a per-check INFO record" {
        telemetry.record(result("app-health", isHealthy = true))
        telemetry.record(result("app-health", isHealthy = true))

        events.list.shouldBeEmpty()
    }

    "the gauge callback never performs I/O — collection only reads the last observation" {
        telemetry.record(result("mysql-connection", isHealthy = true))

        val first = gaugeValues(reader)
        val second = gaugeValues(reader)

        first shouldBe second
    }
})

private fun result(serviceName: String, isHealthy: Boolean) = HealthCheckResult(
    serviceName = serviceName,
    isHealthy = isHealthy,
    timestamp = LocalDateTime(2026, 1, 1, 0, 0),
)

private fun metric(reader: InMemoryMetricReader, name: String): MetricData = reader.collectAllMetrics()
    .single { it.name == name }

private fun gaugeValues(reader: InMemoryMetricReader): Map<String, Long> = metric(reader, MetricCatalog.HEALTH_STATUS)
    .longGaugeData.points
    .associate { (it.attributes.get(componentKey) ?: "") to it.value }
