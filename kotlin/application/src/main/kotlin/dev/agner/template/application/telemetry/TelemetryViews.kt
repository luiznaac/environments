package dev.agner.template.application.telemetry

import dev.agner.template.usecase.commons.MetricCatalog
import io.opentelemetry.sdk.metrics.Aggregation
import io.opentelemetry.sdk.metrics.ExplicitBucketHistogramOptions
import io.opentelemetry.sdk.metrics.InstrumentSelector
import io.opentelemetry.sdk.metrics.View

/**
 * The SDK views that keep the emitted series inside the standard's catalog: the two HTTP
 * histograms use the explicit bucket boundaries and the attribute allowlists, and the
 * duplicate count plus the `system.*` runtime instruments are dropped.
 */
object TelemetryViews {

    val views: List<Pair<InstrumentSelector, View>> = listOf(
        histogram(MetricCatalog.HTTP_SERVER_DURATION, MetricCatalog.HTTP_SERVER_ATTRIBUTES),
        histogram(MetricCatalog.HTTP_CLIENT_DURATION, MetricCatalog.HTTP_CLIENT_ATTRIBUTES),
        drop(MetricCatalog.DROPPED_HTTP_SERVER_COUNT),
        drop(MetricCatalog.DROPPED_SYSTEM_PREFIX),
    )

    private fun histogram(name: String, attributeKeys: Set<String>) =
        selector(name) to View.builder()
            .setAggregation(
                Aggregation.explicitBucketHistogram(
                    ExplicitBucketHistogramOptions.builder()
                        .setBucketBoundaries(MetricCatalog.HTTP_DURATION_BUCKETS)
                        .build(),
                ),
            )
            .setAttributeFilter(attributeKeys)
            .build()

    private fun drop(name: String) = selector(name) to View.builder()
        .setAggregation(Aggregation.drop())
        .build()

    private fun selector(name: String) = InstrumentSelector.builder().setName(name).build()
}
