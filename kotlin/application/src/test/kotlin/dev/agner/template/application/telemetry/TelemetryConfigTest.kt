package dev.agner.template.application.telemetry

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.LoggerContext
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.classic.spi.LoggingEvent
import ch.qos.logback.core.read.ListAppender
import com.fasterxml.jackson.core.JsonFactory
import dev.agner.template.usecase.commons.MetricCatalog
import dev.agner.template.usecase.commons.TelemetryAttributes
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.mockk.mockk
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.logs.Severity
import io.opentelemetry.instrumentation.api.config.IncludeExclude
import io.opentelemetry.instrumentation.logback.appender.v1_0.OpenTelemetryAppender
import io.opentelemetry.instrumentation.runtimetelemetry.RuntimeTelemetry
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.common.CompletableResultCode
import io.opentelemetry.sdk.logs.SdkLoggerProvider
import io.opentelemetry.sdk.logs.data.LogRecordData
import io.opentelemetry.sdk.logs.export.LogRecordExporter
import io.opentelemetry.sdk.logs.export.SimpleLogRecordProcessor
import io.opentelemetry.sdk.metrics.InstrumentType
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.metrics.data.AggregationTemporality
import io.opentelemetry.sdk.metrics.data.MetricData
import io.opentelemetry.sdk.metrics.export.MetricExporter
import io.opentelemetry.sdk.testing.exporter.InMemoryLogRecordExporter
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import io.opentelemetry.sdk.trace.SdkTracerProvider
import net.logstash.logback.composite.JsonProvider
import net.logstash.logback.composite.loggingevent.LoggingEventJsonProviders
import net.logstash.logback.composite.loggingevent.MdcJsonProvider
import net.logstash.logback.composite.loggingevent.StackTraceJsonProvider
import net.logstash.logback.composite.loggingevent.ThrowableClassNameJsonProvider
import net.logstash.logback.composite.loggingevent.ThrowableMessageJsonProvider
import net.logstash.logback.encoder.LoggingEventCompositeJsonEncoder
import org.slf4j.LoggerFactory

private const val SERVICE_NAME = "orders"

class TelemetryConfigTest : StringSpec({

    "the resource carries the six contract attributes" {
        val settings = settings(environment = "dev", version = "1.2.3", host = "host-a", instanceId = "instance-a")

        val resource = TelemetryResource.of(settings)

        resource.getAttribute(AttributeKey.stringKey(TelemetryAttributes.SERVICE_NAME)) shouldBe SERVICE_NAME
        resource.getAttribute(AttributeKey.stringKey(TelemetryAttributes.SERVICE_NAMESPACE)) shouldBe "luiznaac"
        resource.getAttribute(AttributeKey.stringKey(TelemetryAttributes.SERVICE_VERSION)) shouldBe "1.2.3"
        resource.getAttribute(
            AttributeKey.stringKey(TelemetryAttributes.DEPLOYMENT_ENVIRONMENT_NAME),
        ) shouldBe "dev"
        resource.getAttribute(AttributeKey.stringKey(TelemetryAttributes.SERVICE_INSTANCE_ID)) shouldBe "instance-a"
        resource.getAttribute(AttributeKey.stringKey(TelemetryAttributes.HOST_NAME)) shouldBe "host-a"
    }

    "a missing endpoint under the prod profile fails at boot" {
        shouldThrow<IllegalArgumentException> {
            TelemetrySettings.resolve(
                activeProfiles = listOf("prod"),
                serviceName = SERVICE_NAME,
                endpoint = null,
                console = false,
                environment = emptyMap(),
            )
        }
    }

    "console exporters are rejected in prod" {
        shouldThrow<IllegalArgumentException> {
            TelemetrySettings.resolve(
                activeProfiles = listOf("prod"),
                serviceName = SERVICE_NAME,
                endpoint = "http://otel-collector:4318",
                console = true,
                environment = emptyMap(),
            )
        }
    }

    "dev defaults the endpoint to the local Collector" {
        val settings = TelemetrySettings.resolve(
            activeProfiles = emptyList(),
            serviceName = SERVICE_NAME,
            endpoint = null,
            console = false,
            environment = emptyMap(),
        )

        settings.endpoint shouldBe "http://localhost:4318"
        settings.environment shouldBe "dev"
        settings.pipelines shouldBe TelemetryPipelines(logs = TelemetryExporter.OTLP, metrics = TelemetryExporter.OTLP)
    }

    "TELEMETRY_CONSOLE wins over an exporter env override" {
        val settings = TelemetrySettings.resolve(
            activeProfiles = listOf("dev"),
            serviceName = SERVICE_NAME,
            endpoint = null,
            console = true,
            environment = mapOf("OTEL_LOGS_EXPORTER" to "otlp", "OTEL_METRICS_EXPORTER" to "otlp"),
        )

        settings.pipelines shouldBe TelemetryPipelines(
            logs = TelemetryExporter.CONSOLE,
            metrics = TelemetryExporter.CONSOLE,
        )
    }

    "TELEMETRY_CONSOLE swaps both exporters instead of adding one" {
        val settings = TelemetrySettings.resolve(
            activeProfiles = listOf("dev"),
            serviceName = SERVICE_NAME,
            endpoint = null,
            console = true,
            environment = emptyMap(),
        )

        settings.pipelines shouldBe TelemetryPipelines(
            logs = TelemetryExporter.CONSOLE,
            metrics = TelemetryExporter.CONSOLE,
        )
    }

    "the test profile exports nothing" {
        val settings = TelemetrySettings.resolve(
            activeProfiles = listOf("test"),
            serviceName = SERVICE_NAME,
            endpoint = null,
            console = false,
            environment = emptyMap(),
        )

        settings.environment shouldBe "test"
        settings.pipelines shouldBe TelemetryPipelines(logs = TelemetryExporter.NONE, metrics = TelemetryExporter.NONE)
    }

    "no trace exporter is ever configured" {
        settings(environment = "prod", endpoint = "http://otel-collector:4318").pipelines.traces shouldBe
            TelemetryExporter.NONE
    }

    "the environment supplies the service name, version, host and resource remainder" {
        val settings = TelemetrySettings.resolve(
            activeProfiles = listOf("dev"),
            serviceName = SERVICE_NAME,
            endpoint = null,
            console = false,
            environment = mapOf(
                "OTEL_SERVICE_NAME" to "env-service",
                "SERVICE_VERSION" to "9.9.9",
                "HOSTNAME" to "env-host",
                "OTEL_RESOURCE_ATTRIBUTES" to "team=checkout,region=br",
                "OTEL_BLRP_SCHEDULE_DELAY" to "1500",
                "OTEL_METRIC_EXPORT_INTERVAL" to "2500",
            ),
        )

        settings.serviceName shouldBe "env-service"
        settings.version shouldBe "9.9.9"
        settings.hostName shouldBe "env-host"
        settings.resourceAttributes shouldBe mapOf("team" to "checkout", "region" to "br")
        settings.logScheduleDelayMillis shouldBe 1500
        settings.metricExportIntervalMillis shouldBe 2500
    }

    "the custom meter scope is the service name and version" {
        val settings = settings(environment = "dev", version = "1.2.3")
        val reader = InMemoryMetricReader.create()
        val sdk = OpenTelemetrySdk.builder()
            .setMeterProvider(SdkMeterProvider.builder().registerMetricReader(reader).build())
            .build()

        Telemetry.meter(sdk, settings).counterBuilder("health.check.failures").build().add(1)

        val scope = reader.collectAllMetrics().single().instrumentationScopeInfo
        scope.name shouldBe SERVICE_NAME
        scope.version shouldBe "1.2.3"
        sdk.shutdown()
    }

    "production maps to prod and any other profile keeps its name" {
        TelemetrySettings.environmentName(listOf("production")) shouldBe "prod"
        TelemetrySettings.environmentName(listOf("staging")) shouldBe "staging"
        TelemetrySettings.environmentName(emptyList()) shouldBe "dev"
    }

    "the exporter env contract can stop export without a code change" {
        val settings = TelemetrySettings.resolve(
            activeProfiles = listOf("dev"),
            serviceName = SERVICE_NAME,
            endpoint = null,
            console = false,
            environment = mapOf("OTEL_LOGS_EXPORTER" to "none", "OTEL_METRICS_EXPORTER" to "none"),
        )

        settings.pipelines shouldBe TelemetryPipelines(logs = TelemetryExporter.NONE, metrics = TelemetryExporter.NONE)
    }

    "the traces exporter must stay none" {
        shouldThrow<IllegalArgumentException> {
            TelemetrySettings.resolve(
                activeProfiles = listOf("dev"),
                serviceName = SERVICE_NAME,
                endpoint = null,
                console = false,
                environment = mapOf("OTEL_TRACES_EXPORTER" to "otlp"),
            )
        }
    }

    "the runtime subset is exported and system.* is dropped" {
        val reader = InMemoryMetricReader.create()
        val sdk = OpenTelemetrySdk.builder()
            .setMeterProvider(
                SdkMeterProvider.builder()
                    .registerMetricReader(reader)
                    .apply { TelemetryViews.views.forEach { (selector, view) -> registerView(selector, view) } }
                    .build(),
            )
            .build()
        val runtime = RuntimeTelemetry.create(sdk)

        repeat(3) {
            System.gc()
            Thread.sleep(50)
        }
        val names = reader.collectAllMetrics().map { it.name }

        names shouldContainAll listOf(
            MetricCatalog.RUNTIME_MEMORY_USED,
            MetricCatalog.RUNTIME_MEMORY_LIMIT,
            MetricCatalog.RUNTIME_GC_DURATION,
            MetricCatalog.RUNTIME_THREAD_COUNT,
            MetricCatalog.RUNTIME_CPU_UTILIZATION,
            MetricCatalog.RUNTIME_CLASS_COUNT,
        )
        names.none { it.startsWith("system.") } shouldBe true
        names.none { it.startsWith("db.client.") } shouldBe true
        names shouldNotContain MetricCatalog.DROPPED_HTTP_SERVER_COUNT

        runtime.close()
        sdk.shutdown()
    }

    "a configured-but-down endpoint never fails the SDK build or shutdown" {
        val runtime = Telemetry.build(settings(environment = "dev", endpoint = "http://127.0.0.1:1"))

        runtime.shutdown()
    }

    "the stdout renderings receive the six resource attributes" {
        val settings = settings(environment = "dev", version = "1.2.3", host = "host-a", instanceId = "instance-a")
        TelemetryResourceValues.install(settings)

        val rendered = TelemetryJsonProviders.ResourceConverter().convert(mockk())
        rendered shouldContain "service.name=orders"
        rendered shouldContain "service.namespace=luiznaac"
        rendered shouldContain "service.version=1.2.3"
        rendered shouldContain "deployment.environment.name=dev"
        rendered shouldContain "service.instance.id=instance-a"
        rendered shouldContain "host.name=host-a"

        val output = java.io.StringWriter()
        val generator = JsonFactory().createGenerator(output)
        generator.writeStartObject()
        TelemetryJsonProviders.ResourceJsonProvider().writeTo(generator, mockk())
        generator.writeEndObject()
        generator.flush()
        output.toString() shouldContain "\"service.name\":\"orders\""
    }

    "a down collector logs one WARN per outage and resets after a success" {
        val context = LoggerFactory.getILoggerFactory() as LoggerContext
        val logger = context.getLogger("warn-once-test")
        val events = ListAppender<ILoggingEvent>()
        events.context = context
        events.start()
        logger.addAppender(events)

        var result = CompletableResultCode.ofFailure()
        val warning = ExportWarning(logger)
        val logExporter = WarnOnceLogRecordExporter(
            object : LogRecordExporter {
                override fun export(logRecords: Collection<LogRecordData>) = result
                override fun flush() = CompletableResultCode.ofSuccess()
                override fun shutdown() = CompletableResultCode.ofSuccess()
            },
            warning,
        )
        val metricExporter = WarnOnceMetricExporter(
            object : MetricExporter {
                override fun export(metrics: Collection<MetricData>) = result
                override fun flush() = CompletableResultCode.ofSuccess()
                override fun shutdown() = CompletableResultCode.ofSuccess()
                override fun getAggregationTemporality(instrumentType: InstrumentType) =
                    AggregationTemporality.CUMULATIVE
            },
            warning,
        )

        logExporter.export(emptyList())
        metricExporter.export(emptyList())
        events.list.size shouldBe 1
        val event = events.list.single()
        event.level shouldBe Level.WARN
        event.message shouldBe "telemetry.export.failed"
        event.mdcPropertyMap["telemetry.signal"] shouldBe "logs"
        event.mdcPropertyMap.containsKey("signal") shouldBe false

        result = CompletableResultCode.ofSuccess()
        logExporter.export(emptyList())
        result = CompletableResultCode.ofFailure()
        logExporter.export(emptyList())

        events.list.size shouldBe 2
        logger.detachAppender(events)
    }

    "the views keep the HTTP allowlist and drop duplicate/system instruments" {
        val reader = InMemoryMetricReader.create()
        val sdk = OpenTelemetrySdk.builder()
            .setMeterProvider(
                SdkMeterProvider.builder()
                    .registerMetricReader(reader)
                    .apply {
                        for ((selector, view) in TelemetryViews.views) {
                            registerView(selector, view)
                        }
                    }
                    .build(),
            )
            .build()
        val meter = sdk.getMeter("test-service")
        meter.histogramBuilder(MetricCatalog.HTTP_SERVER_DURATION)
            .setUnit(MetricCatalog.SECONDS)
            .build()
            .record(
                0.2,
                Attributes.of(
                    AttributeKey.stringKey(TelemetryAttributes.HTTP_REQUEST_METHOD),
                    "GET",
                    AttributeKey.stringKey("user_agent.original"),
                    "curl",
                ),
            )
        meter.counterBuilder(MetricCatalog.DROPPED_HTTP_SERVER_COUNT).build().add(1)
        meter.counterBuilder("system.cpu.utilization").build().add(1)

        val metrics = reader.collectAllMetrics()
        metrics.none { it.name == MetricCatalog.DROPPED_HTTP_SERVER_COUNT } shouldBe true
        metrics.none { it.name.startsWith("system.") } shouldBe true
        val point = metrics.single { it.name == MetricCatalog.HTTP_SERVER_DURATION }
            .histogramData.points.single()
        point.boundaries shouldBe MetricCatalog.HTTP_DURATION_BUCKETS
        point.attributes.get(AttributeKey.stringKey("user_agent.original")) shouldBe null
        point.attributes.get(AttributeKey.stringKey(TelemetryAttributes.HTTP_REQUEST_METHOD)) shouldBe "GET"
        sdk.shutdown()
    }

    "the appender maps levels to OTel severity and never emits a span id" {
        val exporter = InMemoryLogRecordExporter.create()
        val sdk = OpenTelemetrySdk.builder()
            .setLoggerProvider(
                SdkLoggerProvider.builder()
                    .addLogRecordProcessor(SimpleLogRecordProcessor.create(exporter))
                    .build(),
            )
            .build()
        OpenTelemetryAppender.install(sdk)
        val context = LoggerFactory.getILoggerFactory() as LoggerContext
        val logger: Logger = context.getLogger("severity-test")
        logger.level = Level.DEBUG
        val appender = OpenTelemetryAppender().apply {
            this.context = context
            setOpenTelemetry(sdk)
            setMdcAttributes(IncludeExclude.builder().setIncluded("*").build())
            start()
        }
        logger.addAppender(appender)

        logger.debug("d")
        logger.info("i")
        logger.warn("w")
        logger.error("e")

        val records = exporter.finishedLogRecordItems
        records.map { it.severityText } shouldBe listOf("DEBUG", "INFO", "WARN", "ERROR")
        records.map { it.severity } shouldBe listOf(Severity.DEBUG, Severity.INFO, Severity.WARN, Severity.ERROR)
        records.all { !it.spanContext.isValid } shouldBe true
        logger.detachAppender(appender)
    }

    "the built SDK installs no span processor and no trace exporter" {
        val runtime = Telemetry.build(settings(environment = "test"))

        val sharedState = SdkTracerProvider::class.java
            .getDeclaredField("sharedState")
            .apply { isAccessible = true }
            .get(runtime.openTelemetry.sdkTracerProvider)
        val hasNoSpanProcessor = sharedState.javaClass
            .getDeclaredMethod("hasNoSpanProcessor")
            .apply { isAccessible = true }
            .invoke(sharedState) as Boolean

        hasNoSpanProcessor shouldBe true
        runtime.shutdown()
    }

    "the prod JSON encoder pins the record fields and exception semconv" {
        val context = LoggerFactory.getILoggerFactory() as LoggerContext
        val providers = LoggingEventJsonProviders()
        fun add(provider: JsonProvider<ILoggingEvent>) {
            provider.context = context
            provider.start()
            providers.addProvider(provider)
        }
        add(TelemetryJsonProviders.TimestampJsonProvider())
        add(TelemetryJsonProviders.ObservedTimestampJsonProvider())
        add(TelemetryJsonProviders.SeverityTextJsonProvider())
        add(TelemetryJsonProviders.SeverityNumberJsonProvider())
        add(TelemetryJsonProviders.BodyJsonProvider())
        add(TelemetryJsonProviders.EventNameJsonProvider())
        add(TelemetryJsonProviders.ResourceJsonProvider())
        add(
            MdcJsonProvider().apply {
                addExcludeMdcKeyName(TelemetryAttributes.EVENT_NAME)
            },
        )
        add(
            ThrowableClassNameJsonProvider().apply {
                fieldName = "exception.type"
                setUseSimpleClassName(false)
            },
        )
        add(
            ThrowableMessageJsonProvider().apply {
                fieldName = "exception.message"
            },
        )
        add(
            StackTraceJsonProvider().apply {
                fieldName = "exception.stacktrace"
            },
        )
        val encoder = LoggingEventCompositeJsonEncoder().apply {
            this.context = context
            setProviders(providers)
            start()
        }
        TelemetryResourceValues.install(settings(environment = "dev", version = "1.2.3"))
        val logger = LoggerFactory.getLogger("json-test") as Logger
        val event = LoggingEvent(
            "fqcn",
            logger,
            Level.ERROR,
            "http.request.failed",
            IllegalStateException("boom"),
            emptyArray(),
        )
        event.mdcPropertyMap = mapOf(
            TelemetryAttributes.EVENT_NAME to "http.request.failed",
            TelemetryAttributes.REQUEST_ID to "request-12345678",
        )

        val json = encoder.encode(event).toString(Charsets.UTF_8)

        json shouldContain "\"timestamp\":"
        json shouldContain "\"observed_timestamp\":"
        json shouldContain "\"severity_text\":\"ERROR\""
        json shouldContain "\"severity_number\":17"
        json shouldContain "\"body\":\"http.request.failed\""
        json shouldContain "\"event.name\":\"http.request.failed\""
        json shouldContain "\"request.id\":\"request-12345678\""
        json shouldContain "\"exception.type\":\"java.lang.IllegalStateException\""
        json shouldContain "\"exception.message\":\"boom\""
        json shouldContain "\"exception.stacktrace\":"
        json shouldContain "\"service.name\":\"orders\""
    }

    "the normalize step stamps event.name from the body when a plain log carries none" {
        val exporter = InMemoryLogRecordExporter.create()
        val provider = SdkLoggerProvider.builder()
            .addLogRecordProcessor(EventNameStampingProcessor())
            .addLogRecordProcessor(SimpleLogRecordProcessor.create(exporter))
            .build()

        provider.loggerBuilder("telemetry-test").build()
            .logRecordBuilder()
            .setBody("route table initialized")
            .emit()

        val record = exporter.finishedLogRecordItems.single()
        record.attributes.get(AttributeKey.stringKey(TelemetryAttributes.EVENT_NAME)) shouldBe "route table initialized"
    }
})

private fun settings(
    environment: String,
    endpoint: String? = null,
    version: String = "1.0",
    host: String = "localhost",
    instanceId: String = "instance",
) = TelemetrySettings(
    serviceName = SERVICE_NAME,
    endpoint = endpoint,
    console = false,
    environment = environment,
    version = version,
    hostName = host,
    instanceId = instanceId,
)
