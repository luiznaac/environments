package dev.agner.template.application.telemetry

import dev.agner.template.usecase.commons.EventLevel
import dev.agner.template.usecase.commons.TelemetryAttributes
import dev.agner.template.usecase.commons.event
import io.opentelemetry.api.OpenTelemetry
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.metrics.Meter
import io.opentelemetry.context.Context
import io.opentelemetry.exporter.logging.LoggingMetricExporter
import io.opentelemetry.exporter.logging.SystemOutLogRecordExporter
import io.opentelemetry.exporter.otlp.http.logs.OtlpHttpLogRecordExporter
import io.opentelemetry.exporter.otlp.http.metrics.OtlpHttpMetricExporter
import io.opentelemetry.instrumentation.runtimetelemetry.RuntimeTelemetry
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.common.CompletableResultCode
import io.opentelemetry.sdk.logs.LogRecordProcessor
import io.opentelemetry.sdk.logs.ReadWriteLogRecord
import io.opentelemetry.sdk.logs.SdkLoggerProvider
import io.opentelemetry.sdk.logs.data.LogRecordData
import io.opentelemetry.sdk.logs.export.BatchLogRecordProcessor
import io.opentelemetry.sdk.logs.export.LogRecordExporter
import io.opentelemetry.sdk.logs.export.SimpleLogRecordProcessor
import io.opentelemetry.sdk.metrics.InstrumentType
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.metrics.data.MetricData
import io.opentelemetry.sdk.metrics.export.AggregationTemporalitySelector
import io.opentelemetry.sdk.metrics.export.MetricExporter
import io.opentelemetry.sdk.metrics.export.PeriodicMetricReader
import io.opentelemetry.sdk.resources.Resource
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.net.InetAddress
import java.util.Properties
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

enum class TelemetryExporter { OTLP, CONSOLE, NONE }

data class TelemetryPipelines(
    val logs: TelemetryExporter,
    val metrics: TelemetryExporter,
) {
    val traces: TelemetryExporter get() = TelemetryExporter.NONE
}

data class TelemetrySettings(
    val serviceName: String,
    val endpoint: String?,
    val console: Boolean,
    val environment: String,
    val version: String,
    val hostName: String,
    val instanceId: String = UUID.randomUUID().toString(),
    val resourceAttributes: Map<String, String> = emptyMap(),
    val logScheduleDelayMillis: Long = DEFAULT_LOG_SCHEDULE_DELAY_MILLIS,
    val metricExportIntervalMillis: Long = DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS,
    val logExporter: TelemetryExporter? = null,
    val metricExporter: TelemetryExporter? = null,
) {

    val pipelines: TelemetryPipelines
        get() = when {
            environment == TEST_ENVIRONMENT ->
                TelemetryPipelines(logs = TelemetryExporter.NONE, metrics = TelemetryExporter.NONE)
            console -> TelemetryPipelines(logs = TelemetryExporter.CONSOLE, metrics = TelemetryExporter.CONSOLE)
            else -> TelemetryPipelines(
                logs = logExporter ?: TelemetryExporter.OTLP,
                metrics = metricExporter ?: TelemetryExporter.OTLP,
            )
        }

    companion object {
        const val PROD_ENVIRONMENT = "prod"
        const val DEV_ENVIRONMENT = "dev"
        const val TEST_ENVIRONMENT = "test"
        const val DEV_DEFAULT_ENDPOINT = "http://localhost:4318"
        const val SERVICE_NAMESPACE = "luiznaac"
        private const val DEFAULT_LOG_SCHEDULE_DELAY_MILLIS = 5000L
        private const val DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS = 60000L

        fun resolve(
            activeProfiles: List<String>,
            serviceName: String,
            endpoint: String?,
            console: Boolean,
            environment: Map<String, String> = System.getenv(),
            version: String = buildVersion(),
        ): TelemetrySettings {
            val environmentName = environmentName(activeProfiles)
            require(!(environmentName == PROD_ENVIRONMENT && console)) {
                "TELEMETRY_CONSOLE is a dev-only switch and cannot be enabled in prod"
            }
            val tracesExporter = environment["OTEL_TRACES_EXPORTER"] ?: "none"
            require(tracesExporter == "none") {
                "traces are not part of this contract; OTEL_TRACES_EXPORTER must be none"
            }
            val resolvedEndpoint = endpoint?.takeIf { it.isNotBlank() }
                ?: devEndpointOrNull(environmentName)
            val logExporter = exporterOverride(environment["OTEL_LOGS_EXPORTER"], "OTEL_LOGS_EXPORTER")
            val metricExporter = exporterOverride(environment["OTEL_METRICS_EXPORTER"], "OTEL_METRICS_EXPORTER")
            require(!(environmentName == PROD_ENVIRONMENT && logExporter == TelemetryExporter.CONSOLE)) {
                "console exporters are dev-only"
            }
            require(!(environmentName == PROD_ENVIRONMENT && metricExporter == TelemetryExporter.CONSOLE)) {
                "console exporters are dev-only"
            }
            return TelemetrySettings(
                serviceName = environment["OTEL_SERVICE_NAME"] ?: serviceName,
                endpoint = resolvedEndpoint,
                console = console,
                environment = environmentName,
                version = environment["SERVICE_VERSION"] ?: version,
                hostName = environment["HOSTNAME"] ?: localHostName(),
                resourceAttributes = parseResourceAttributes(environment["OTEL_RESOURCE_ATTRIBUTES"]),
                logScheduleDelayMillis = positiveLong(environment["OTEL_BLRP_SCHEDULE_DELAY"])
                    ?: DEFAULT_LOG_SCHEDULE_DELAY_MILLIS,
                metricExportIntervalMillis = positiveLong(environment["OTEL_METRIC_EXPORT_INTERVAL"])
                    ?: DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS,
                logExporter = logExporter,
                metricExporter = metricExporter,
            )
        }

        fun environmentName(activeProfiles: List<String>): String = when (val first = activeProfiles.firstOrNull()) {
            null -> DEV_ENVIRONMENT
            "prod", "production" -> PROD_ENVIRONMENT
            else -> first
        }

        private fun devEndpointOrNull(environmentName: String): String? {
            require(environmentName != PROD_ENVIRONMENT) {
                "OTEL_EXPORTER_OTLP_ENDPOINT is required under the prod profile"
            }
            return DEV_DEFAULT_ENDPOINT
        }

        private fun parseResourceAttributes(raw: String?): Map<String, String> = raw
            ?.split(',')
            ?.mapNotNull { entry ->
                val separator = entry.indexOf('=')
                if (separator <= 0) {
                    null
                } else {
                    entry.substring(0, separator).trim() to entry.substring(separator + 1).trim()
                }
            }
            ?.toMap()
            .orEmpty()

        private fun positiveLong(raw: String?): Long? = raw?.toLongOrNull()?.takeIf { it > 0 }

        private fun exporterOverride(raw: String?, name: String): TelemetryExporter? = when (raw?.lowercase()) {
            null -> null
            "otlp" -> TelemetryExporter.OTLP
            "console" -> TelemetryExporter.CONSOLE
            "none" -> TelemetryExporter.NONE
            else -> throw IllegalArgumentException("$name has an unsupported value: $raw")
        }

        private fun localHostName(): String = runCatching { InetAddress.getLocalHost().hostName }
            .getOrDefault("unknown")

        fun buildVersion(): String = runCatching {
            TelemetrySettings::class.java.getResourceAsStream("/build-info.properties")
                ?.use { stream ->
                    val properties = Properties()
                    properties.load(stream)
                    properties.getProperty("version")
                }
        }.getOrNull() ?: "dev"
    }
}

class TelemetryRuntime(
    val openTelemetry: OpenTelemetrySdk,
    private val runtimeTelemetry: RuntimeTelemetry,
) : AutoCloseable {

    fun shutdown(): Boolean {
        runtimeTelemetry.close()
        return openTelemetry.shutdown().join(10, TimeUnit.SECONDS).isSuccess
    }

    override fun close() {
        shutdown()
    }
}

object Telemetry {

    fun build(settings: TelemetrySettings): TelemetryRuntime {
        TelemetryResourceValues.install(settings)
        val resource = TelemetryResource.of(settings)
        val warning = ExportWarning()
        val loggerProvider = buildLoggerProvider(settings, resource, warning)
        val meterProvider = buildMeterProvider(settings, resource, warning)
        val sdk = OpenTelemetrySdk.builder()
            .setLoggerProvider(loggerProvider)
            .setMeterProvider(meterProvider)
            .build()
        return TelemetryRuntime(sdk, RuntimeTelemetry.create(sdk))
    }

    fun meter(openTelemetry: OpenTelemetry, settings: TelemetrySettings): Meter =
        openTelemetry.meterBuilder(settings.serviceName)
            .setInstrumentationVersion(settings.version)
            .build()

    private fun buildLoggerProvider(
        settings: TelemetrySettings,
        resource: Resource,
        warning: ExportWarning,
    ): SdkLoggerProvider {
        val builder = SdkLoggerProvider.builder()
            .setResource(resource)
            .addLogRecordProcessor(EventNameStampingProcessor())
        val processor = logProcessor(settings, warning)
        if (processor != null) {
            builder.addLogRecordProcessor(processor)
        }
        return builder.build()
    }

    private fun logProcessor(settings: TelemetrySettings, warning: ExportWarning): LogRecordProcessor? {
        val exporter = when (settings.pipelines.logs) {
            TelemetryExporter.OTLP -> WarnOnceLogRecordExporter(otlpLogExporter(settings), warning)
            TelemetryExporter.CONSOLE -> SystemOutLogRecordExporter.create()
            TelemetryExporter.NONE -> null
        } ?: return null
        return if (settings.pipelines.logs == TelemetryExporter.OTLP) {
            batchLogProcessor(exporter, settings)
        } else {
            SimpleLogRecordProcessor.create(exporter)
        }
    }

    private fun buildMeterProvider(
        settings: TelemetrySettings,
        resource: Resource,
        warning: ExportWarning,
    ): SdkMeterProvider {
        val builder = SdkMeterProvider.builder().setResource(resource)
        for ((selector, view) in TelemetryViews.views) {
            builder.registerView(selector, view)
        }
        val exporter = when (settings.pipelines.metrics) {
            TelemetryExporter.OTLP -> WarnOnceMetricExporter(otlpMetricExporter(settings), warning)
            TelemetryExporter.CONSOLE -> LoggingMetricExporter.create()
            TelemetryExporter.NONE -> null
        }
        if (exporter != null) {
            builder.registerMetricReader(
                PeriodicMetricReader.builder(exporter)
                    .setInterval(settings.metricExportIntervalMillis, TimeUnit.MILLISECONDS)
                    .build(),
            )
        }
        return builder.build()
    }

    private fun otlpLogExporter(settings: TelemetrySettings): LogRecordExporter = OtlpHttpLogRecordExporter.builder()
        .setEndpoint(endpoint(settings, "/v1/logs"))
        .setTimeout(10, TimeUnit.SECONDS)
        .build()

    private fun otlpMetricExporter(settings: TelemetrySettings): MetricExporter = OtlpHttpMetricExporter.builder()
        .setEndpoint(endpoint(settings, "/v1/metrics"))
        .setTimeout(10, TimeUnit.SECONDS)
        .setAggregationTemporalitySelector(AggregationTemporalitySelector.alwaysCumulative())
        .build()

    private fun batchLogProcessor(exporter: LogRecordExporter, settings: TelemetrySettings) =
        BatchLogRecordProcessor.builder(exporter)
            .setScheduleDelay(settings.logScheduleDelayMillis, TimeUnit.MILLISECONDS)
            .setMaxQueueSize(2048)
            .setExporterTimeout(10, TimeUnit.SECONDS)
            .build()

    private fun endpoint(settings: TelemetrySettings, path: String) =
        "${settings.endpoint.orEmpty().trimEnd('/')}$path"
}

class EventNameStampingProcessor : LogRecordProcessor {

    private val eventNameKey = AttributeKey.stringKey(TelemetryAttributes.EVENT_NAME)

    override fun onEmit(context: Context, logRecord: ReadWriteLogRecord) {
        if (logRecord.getAttribute(eventNameKey) != null) {
            return
        }
        val body = logRecord.getBodyValue()?.asString()
        if (!body.isNullOrBlank()) {
            logRecord.setAttribute(eventNameKey, body)
        }
    }

    override fun shutdown(): CompletableResultCode = CompletableResultCode.ofSuccess()

    override fun forceFlush(): CompletableResultCode = CompletableResultCode.ofSuccess()

    override fun close() = Unit
}

private const val SIGNAL_ATTRIBUTE = "telemetry.signal"
private const val COLLECTOR_UNREACHABLE = "collector_unreachable"
private const val TELEMETRY_EXPORT_FAILED = "telemetry.export.failed"

class ExportWarning(
    private val log: Logger = LoggerFactory.getLogger(ExportWarning::class.java),
) {

    private val warned = AtomicBoolean(false)

    fun report(result: CompletableResultCode, signal: String) {
        if (result.isSuccess) {
            warned.set(false)
        } else if (warned.compareAndSet(false, true)) {
            log.event(
                TELEMETRY_EXPORT_FAILED,
                TelemetryAttributes.ERROR_TYPE to COLLECTOR_UNREACHABLE,
                SIGNAL_ATTRIBUTE to signal,
                level = EventLevel.WARN,
            )
        }
    }
}

class WarnOnceLogRecordExporter(
    private val delegate: LogRecordExporter,
    private val warning: ExportWarning,
) : LogRecordExporter {

    override fun export(logRecords: Collection<LogRecordData>): CompletableResultCode {
        val result = delegate.export(logRecords)
        result.whenComplete { warning.report(result, "logs") }
        return result
    }

    override fun flush(): CompletableResultCode = delegate.flush()

    override fun shutdown(): CompletableResultCode = delegate.shutdown()
}

class WarnOnceMetricExporter(
    private val delegate: MetricExporter,
    private val warning: ExportWarning,
) : MetricExporter {

    override fun export(metrics: Collection<MetricData>): CompletableResultCode {
        val result = delegate.export(metrics)
        result.whenComplete { warning.report(result, "metrics") }
        return result
    }

    override fun flush(): CompletableResultCode = delegate.flush()

    override fun shutdown(): CompletableResultCode = delegate.shutdown()

    override fun getAggregationTemporality(instrumentType: InstrumentType) =
        delegate.getAggregationTemporality(instrumentType)

    override fun getDefaultAggregation(instrumentType: InstrumentType) = delegate.getDefaultAggregation(instrumentType)

    override fun getMemoryMode() = delegate.getMemoryMode()
}
