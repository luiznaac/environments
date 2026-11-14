package dev.agner.template.usecase.health

import dev.agner.template.usecase.commons.EventLevel
import dev.agner.template.usecase.commons.MetricCatalog
import dev.agner.template.usecase.commons.TelemetryAttributes
import dev.agner.template.usecase.commons.event
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.metrics.Meter
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.util.concurrent.ConcurrentHashMap

/**
 * The `health.check.*` instruments and their state-transition logs. The gauge reports the
 * last observation recorded by the health endpoint and never performs I/O itself; the
 * counter makes flaps between exports visible. `docs/observability.md` §5 (Health).
 */
class HealthTelemetry(
    meter: Meter,
    private val log: Logger = LoggerFactory.getLogger(HealthTelemetry::class.java),
) {

    private val lastStatuses = ConcurrentHashMap<String, Boolean>()

    private val statusGauge = meter.gaugeBuilder(MetricCatalog.HEALTH_STATUS)
        .setDescription("Last observed health check status, 1 healthy and 0 unhealthy")
        .setUnit(MetricCatalog.UNITY)
        .ofLongs()
        .buildWithCallback { observation ->
            for ((component, healthy) in lastStatuses) {
                observation.record(if (healthy) 1L else 0L, statusAttributes(component))
            }
        }

    private val failures = meter.counterBuilder(MetricCatalog.HEALTH_FAILURES)
        .setDescription("Number of failed health checks")
        .setUnit(MetricCatalog.CHECKS)
        .build()

    fun record(result: HealthCheckResult) {
        val previous = lastStatuses.put(result.serviceName, result.isHealthy)
        if (!result.isHealthy) {
            recordFailure(result.serviceName)
            if (previous != false) {
                log.event(
                    "health.check.failed",
                    TelemetryAttributes.HEALTH_COMPONENT to result.serviceName,
                    TelemetryAttributes.ERROR_TYPE to FAILURE_ERROR_TYPE,
                    level = EventLevel.WARN,
                )
            }
        } else if (previous == false) {
            log.event(
                "health.check.recovered",
                TelemetryAttributes.HEALTH_COMPONENT to result.serviceName,
                level = EventLevel.INFO,
            )
        }
    }

    private fun recordFailure(component: String) {
        failures.add(
            1,
            statusAttributes(component).toBuilder()
                .put(AttributeKey.stringKey(TelemetryAttributes.ERROR_TYPE), FAILURE_ERROR_TYPE)
                .build(),
        )
    }

    private fun statusAttributes(component: String) = Attributes.of(
        AttributeKey.stringKey(TelemetryAttributes.HEALTH_COMPONENT),
        component,
    )

    companion object {
        const val FAILURE_ERROR_TYPE = "health_check"
    }
}
