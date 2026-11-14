package dev.agner.template.gateway.configuration

import com.fasterxml.jackson.databind.ObjectMapper
import dev.agner.template.usecase.commons.MetricCatalog
import dev.agner.template.usecase.commons.RequestContext
import dev.agner.template.usecase.commons.TelemetryAttributes
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.get
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext

class ClientTelemetryTest : StringSpec({

    "propagates the request id on the outbound call" {
        var capturedId: String? = null
        val client = client { request ->
            capturedId = request.headers[TelemetryAttributes.REQUEST_ID_HEADER]
        }

        runTest {
            withContext(RequestContext(requestId = "client-request-1")) {
                client.get("http://localhost/service")
            }
        }

        capturedId shouldBe "client-request-1"
    }

    "omits the header when the call is outside a request context" {
        var capturedId: String? = "untouched"
        val client = client { request ->
            capturedId = request.headers[TelemetryAttributes.REQUEST_ID_HEADER]
        }

        runTest {
            client.get("http://localhost/service")
        }

        capturedId shouldBe null
    }

    "records the client duration histogram with the catalog unit and buckets" {
        val reader = InMemoryMetricReader.create()
        val sdk = sdk(reader)
        val engine = MockEngine {
            respond("ok", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/plain"))
        }
        val client = HttpClient(engine) { configureTelemetry(ObjectMapper(), sdk) }

        runTest {
            client.get("http://localhost/service")
        }

        val duration = reader.collectAllMetrics().single { it.name == MetricCatalog.HTTP_CLIENT_DURATION }
        duration.unit shouldBe MetricCatalog.SECONDS
        duration.histogramData.points.single().boundaries shouldBe MetricCatalog.HTTP_DURATION_BUCKETS
    }
})

private fun client(onRequest: (io.ktor.client.request.HttpRequestData) -> Unit): HttpClient {
    val engine = MockEngine { request ->
        onRequest(request)
        respond("ok", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/plain"))
    }
    return HttpClient(engine) { configureTelemetry(ObjectMapper(), sdk(InMemoryMetricReader.create())) }
}

private fun sdk(reader: InMemoryMetricReader) = OpenTelemetrySdk.builder()
    .setMeterProvider(SdkMeterProvider.builder().registerMetricReader(reader).build())
    .build()
