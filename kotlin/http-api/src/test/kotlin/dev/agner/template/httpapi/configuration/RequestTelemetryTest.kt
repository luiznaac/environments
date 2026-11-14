package dev.agner.template.httpapi.configuration

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.LoggerContext
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import dev.agner.template.usecase.commons.DomainException
import dev.agner.template.usecase.commons.MetricCatalog
import dev.agner.template.usecase.commons.RequestContext
import dev.agner.template.usecase.commons.TelemetryAttributes
import io.kotest.core.spec.style.DescribeSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldMatch
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.Routing
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.metrics.data.MetricData
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import org.slf4j.LoggerFactory

private class NotFoundDomainException : DomainException(
    error = TelemetryAttributes.RESOURCE_NOT_FOUND,
    userMessage = "not found",
    detail = "the resource is missing",
)

private class NotFoundStatusMapper : DomainExceptionStatusMapper {
    override fun statusFor(exception: DomainException) = HttpStatusCode.NotFound
}

private data class Harness(
    val reader: InMemoryMetricReader,
)

class RequestTelemetryTest : DescribeSpec({

    lateinit var events: ListAppender<ILoggingEvent>
    lateinit var logger: Logger

    beforeTest {
        val context = LoggerFactory.getILoggerFactory() as LoggerContext
        logger = context.getLogger(RequestTelemetry::class.java)
        events = ListAppender()
        events.context = context
        events.start()
        logger.addAppender(events)
    }

    afterTest {
        logger.detachAppender(events)
    }

    describe("the request telemetry plugin") {

        it("emits one WARN http.request.failed for a 4xx with no exception semconv") {
            val harness = harness()

            testApplication {
                app(harness) {
                    get("/missing") { throw NotFoundDomainException() }
                }

                val response = client.get("/missing") {
                    header(TelemetryAttributes.REQUEST_ID_HEADER, "client-request-1")
                }

                response.status shouldBe HttpStatusCode.NotFound
                response.headers[TelemetryAttributes.REQUEST_ID_HEADER] shouldBe "client-request-1"
                val event = events.list.single()
                event.level shouldBe Level.WARN
                event.message shouldBe "http.request.failed"
                event.throwableProxy.shouldBeNull()
                event.mdcPropertyMap[TelemetryAttributes.HTTP_REQUEST_METHOD] shouldBe "GET"
                event.mdcPropertyMap[TelemetryAttributes.HTTP_ROUTE] shouldBe "/missing"
                event.mdcPropertyMap[TelemetryAttributes.HTTP_RESPONSE_STATUS_CODE] shouldBe "404"
                event.mdcPropertyMap[TelemetryAttributes.ERROR_TYPE] shouldBe TelemetryAttributes.RESOURCE_NOT_FOUND
                event.mdcPropertyMap[TelemetryAttributes.REQUEST_ID] shouldBe "client-request-1"
            }
        }

        it("emits one ERROR with exception semconv for a 5xx") {
            val harness = harness()

            testApplication {
                app(harness) {
                    get("/boom") { throw IllegalStateException("boom") }
                }

                val response = client.get("/boom")

                response.status shouldBe HttpStatusCode.InternalServerError
                val event = events.list.single()
                event.level shouldBe Level.ERROR
                event.throwableProxy.shouldNotBeNull().className shouldBe "java.lang.IllegalStateException"
                event.mdcPropertyMap[TelemetryAttributes.ERROR_TYPE] shouldBe "IllegalStateException"
                event.mdcPropertyMap[TelemetryAttributes.HTTP_RESPONSE_STATUS_CODE] shouldBe "500"
            }
        }

        it("emits no per-request record for a success") {
            val harness = harness()

            testApplication {
                app(harness) {
                    get("/ok") { call.respond(HttpStatusCode.OK) }
                }

                client.get("/ok").status shouldBe HttpStatusCode.OK

                events.list.shouldBeEmpty()
            }
        }

        it("generates an id when the inbound value is invalid and echoes a valid one") {
            val harness = harness()

            testApplication {
                app(harness) {
                    get("/ok") { call.respond(HttpStatusCode.OK) }
                }

                client.get("/ok") { header(TelemetryAttributes.REQUEST_ID_HEADER, "short") }
                    .headers[TelemetryAttributes.REQUEST_ID_HEADER] shouldMatch RequestContext.GENERATED_REQUEST_ID
                client.get("/ok") { header(TelemetryAttributes.REQUEST_ID_HEADER, "valid-client-id-1") }
                    .headers[TelemetryAttributes.REQUEST_ID_HEADER] shouldBe "valid-client-id-1"
            }
        }

        it("leaves http.route absent on an unmatched 404") {
            val harness = harness()

            testApplication {
                app(harness) {
                    get("/ok") { call.respond(HttpStatusCode.OK) }
                }

                client.get("/unknown").status shouldBe HttpStatusCode.NotFound

                val event = events.list.single()
                event.level shouldBe Level.WARN
                event.mdcPropertyMap[TelemetryAttributes.ERROR_TYPE] shouldBe TelemetryAttributes.RESOURCE_NOT_FOUND
                event.mdcPropertyMap.containsKey(TelemetryAttributes.HTTP_ROUTE) shouldBe false
                event.mdcPropertyMap[TelemetryAttributes.URL_PATH] shouldBe "/unknown"

                val unmatched = harness.reader.collectAllMetrics()
                    .single { it.name == MetricCatalog.HTTP_SERVER_DURATION }
                    .histogramData.points
                    .single {
                        it.attributes.get(AttributeKey.longKey(TelemetryAttributes.HTTP_RESPONSE_STATUS_CODE)) == 404L
                    }
                unmatched.attributes.get(AttributeKey.stringKey(TelemetryAttributes.HTTP_ROUTE)) shouldBe null
                unmatched.attributes.get(AttributeKey.stringKey(TelemetryAttributes.URL_PATH)) shouldBe null
            }
        }

        it("returns the in-flight gauge to zero and keeps request.id off every metric") {
            val harness = harness()

            testApplication {
                app(harness) {
                    get("/ok") { call.respond(HttpStatusCode.OK) }
                }

                client.get("/ok")

                val metrics = harness.reader.collectAllMetrics()
                val active = metrics.single { it.name == MetricCatalog.HTTP_SERVER_ACTIVE_REQUESTS }
                active.unit shouldBe MetricCatalog.REQUESTS
                active.longSumData.points.sumOf { it.value } shouldBe 0L
                active.instrumentationScopeInfo.name shouldBe "test-service"
                metrics.allAttributeKeys().shouldNotContain(TelemetryAttributes.REQUEST_ID)
                metrics.map { it.name }.shouldNotContain(MetricCatalog.DROPPED_HTTP_SERVER_COUNT)
            }
        }

        it("emits the server duration histogram with the catalog unit and buckets") {
            val harness = harness()

            testApplication {
                app(harness) {
                    get("/health") { call.respond(HttpStatusCode.OK) }
                }

                client.get("/health")

                val duration = harness.reader.collectAllMetrics()
                    .single { it.name == MetricCatalog.HTTP_SERVER_DURATION }
                duration.unit shouldBe MetricCatalog.SECONDS
                duration.histogramData.points.single().boundaries shouldBe MetricCatalog.HTTP_DURATION_BUCKETS
                duration.histogramData.points.single().attributes.get(
                    AttributeKey.stringKey(TelemetryAttributes.HTTP_ROUTE),
                ) shouldBe "/health"
            }
        }

        it("does not expose a /metrics endpoint") {
            val harness = harness()

            testApplication {
                app(harness) {
                    get("/ok") { call.respond(HttpStatusCode.OK) }
                }

                client.get("/metrics").status shouldBe HttpStatusCode.NotFound
            }
        }
    }
})

private fun harness(): Harness = Harness(InMemoryMetricReader.create())

private fun ApplicationTestBuilder.app(harness: Harness, routes: Routing.() -> Unit) {
    val sdk = OpenTelemetrySdk.builder()
        .setMeterProvider(SdkMeterProvider.builder().registerMetricReader(harness.reader).build())
        .build()
    val telemetry = RequestTelemetry(
        openTelemetry = sdk,
        meter = sdk.meterBuilder("test-service").build(),
        statusMapper = NotFoundStatusMapper(),
    )
    application {
        installTelemetry(telemetry, routes)
    }
}

private fun Application.installTelemetry(telemetry: RequestTelemetry, routes: Routing.() -> Unit) {
    telemetry.install(this)
    install(StatusPages) {
        exception<DomainException> { call, cause ->
            call.respond(NotFoundStatusMapper().statusFor(cause))
        }
        exception<Throwable> { call, _ -> call.respond(HttpStatusCode.InternalServerError) }
    }
    routing(routes)
}

private fun Collection<MetricData>.allAttributeKeys(): List<String> = flatMap { metric ->
    metric.data.points.flatMap { point -> point.attributes.asMap().keys.map { it.key } }
}
