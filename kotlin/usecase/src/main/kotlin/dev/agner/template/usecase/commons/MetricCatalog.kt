package dev.agner.template.usecase.commons

/**
 * The emitted OTel metric names, units and bucket boundaries fixed by
 * `docs/observability.md` §5. The SDK and the contract tests both read this catalog, so a
 * series cannot drift between the wiring and its assertion.
 */
object MetricCatalog {

    const val HTTP_SERVER_DURATION = "http.server.request.duration"
    const val HTTP_SERVER_ACTIVE_REQUESTS = "http.server.active_requests"
    const val HTTP_CLIENT_DURATION = "http.client.request.duration"
    const val HEALTH_STATUS = "health.check.status"
    const val HEALTH_FAILURES = "health.check.failures"

    const val SECONDS = "s"
    const val REQUESTS = "{request}"
    const val CHECKS = "{check}"
    const val UNITY = "1"

    val HTTP_DURATION_BUCKETS = listOf(
        0.005,
        0.01,
        0.025,
        0.05,
        0.075,
        0.1,
        0.25,
        0.5,
        0.75,
        1.0,
        2.5,
        5.0,
        7.5,
        10.0,
    )

    val HTTP_SERVER_ATTRIBUTES = setOf(
        TelemetryAttributes.HTTP_REQUEST_METHOD,
        TelemetryAttributes.HTTP_ROUTE,
        TelemetryAttributes.HTTP_RESPONSE_STATUS_CODE,
        TelemetryAttributes.ERROR_TYPE,
        TelemetryAttributes.URL_SCHEME,
        TelemetryAttributes.NETWORK_PROTOCOL_VERSION,
    )

    val HTTP_CLIENT_ATTRIBUTES = setOf(
        TelemetryAttributes.HTTP_REQUEST_METHOD,
        TelemetryAttributes.SERVER_ADDRESS,
        TelemetryAttributes.SERVER_PORT,
        TelemetryAttributes.HTTP_RESPONSE_STATUS_CODE,
        TelemetryAttributes.ERROR_TYPE,
    )

    const val RUNTIME_MEMORY_USED = "jvm.memory.used"
    const val RUNTIME_MEMORY_LIMIT = "jvm.memory.limit"
    const val RUNTIME_GC_DURATION = "jvm.gc.duration"
    const val RUNTIME_THREAD_COUNT = "jvm.thread.count"
    const val RUNTIME_CPU_UTILIZATION = "jvm.cpu.recent_utilization"
    const val RUNTIME_CLASS_COUNT = "jvm.class.count"
    const val DROPPED_HTTP_SERVER_COUNT = "http.server.request.count"
    const val DROPPED_SYSTEM_PREFIX = "system.*"
}
