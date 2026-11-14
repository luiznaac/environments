package dev.agner.template.gateway.configuration

import com.fasterxml.jackson.databind.ObjectMapper
import dev.agner.template.usecase.commons.TelemetryAttributes
import dev.agner.template.usecase.commons.requestContext
import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.ContentType
import io.ktor.serialization.jackson.JacksonConverter
import io.opentelemetry.api.OpenTelemetry
import io.opentelemetry.instrumentation.ktor.v3_0.KtorClientTelemetry
import kotlinx.coroutines.currentCoroutineContext
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
class KtorClientConfig(
    private val mapper: ObjectMapper,
    private val openTelemetry: OpenTelemetry,
) {

    @Bean
    fun ktorClient() = HttpClient {
        configureTelemetry(mapper, openTelemetry)
    }
}

/**
 * The shared outbound client configuration: content negotiation, the semconv client metrics
 * and the `X-Request-ID` propagation every gateway call shares. `docs/observability.md` §3.
 */
internal fun HttpClientConfig<*>.configureTelemetry(mapper: ObjectMapper, openTelemetry: OpenTelemetry) {
    install(ContentNegotiation) {
        register(ContentType.Application.Json, JacksonConverter(mapper))
    }
    install(KtorClientTelemetry) {
        setOpenTelemetry(openTelemetry)
    }
    install(RequestIdPropagation)
}

private val RequestIdPropagation = createClientPlugin("RequestIdPropagation") {
    onRequest { request, _ ->
        currentCoroutineContext().requestContext?.requestId?.let { requestId ->
            request.headers[TelemetryAttributes.REQUEST_ID_HEADER] = requestId
        }
    }
}
