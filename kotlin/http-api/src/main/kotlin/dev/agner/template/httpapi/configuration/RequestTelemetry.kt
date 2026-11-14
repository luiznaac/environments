package dev.agner.template.httpapi.configuration

import dev.agner.template.usecase.commons.DomainException
import dev.agner.template.usecase.commons.EventLevel
import dev.agner.template.usecase.commons.MetricCatalog
import dev.agner.template.usecase.commons.RequestContext
import dev.agner.template.usecase.commons.TelemetryAttributes
import dev.agner.template.usecase.commons.event
import dev.agner.template.usecase.commons.logger
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.PipelineCall
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.plugins.origin
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import io.ktor.server.response.header
import io.ktor.server.routing.RoutingRoot
import io.ktor.util.AttributeKey
import io.ktor.util.pipeline.PipelineContext
import io.opentelemetry.api.OpenTelemetry
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.metrics.Meter
import io.opentelemetry.instrumentation.ktor.v3_0.KtorServerTelemetry
import kotlinx.coroutines.withContext
import org.springframework.stereotype.Component
import io.opentelemetry.api.common.AttributeKey as OtelAttributeKey

/**
 * Binds the request id before routing, echoes it, keeps the in-flight gauge honest and emits
 * the one boundary record per failed/degraded request. Successful requests stay out of the
 * log lane. `docs/observability.md` §3 (correlation) and §5 (HTTP server).
 */
@Component
class RequestTelemetry(
    private val openTelemetry: OpenTelemetry,
    meter: Meter,
    private val statusMapper: DomainExceptionStatusMapper,
) {

    private val log = logger()

    private val activeRequests = meter.upDownCounterBuilder(MetricCatalog.HTTP_SERVER_ACTIVE_REQUESTS)
        .setDescription("Number of server requests currently in flight")
        .setUnit(MetricCatalog.REQUESTS)
        .build()

    fun install(application: Application) {
        with(application) {
            install(KtorServerTelemetry) {
                setOpenTelemetry(openTelemetry)
            }
            monitor.subscribe(RoutingRoot.RoutingCallStarted) { call ->
                call.attributes.put(ROUTE_ATTRIBUTE, call.route.parent.toString())
            }
            intercept(ApplicationCallPipeline.Call) {
                handle(call)
            }
        }
    }

    private suspend fun PipelineContext<Unit, PipelineCall>.handle(call: ApplicationCall) {
        val requestContext = RequestContext.resolve(call.request.headers[TelemetryAttributes.REQUEST_ID_HEADER])
        call.response.header(TelemetryAttributes.REQUEST_ID_HEADER, requestContext.requireRequestId())
        val activeAttributes = activeAttributes(call)
        withContext(requestContext) {
            activeRequests.add(1, activeAttributes)
            var failure: Throwable? = null
            try {
                proceed()
            } catch (cause: Throwable) {
                failure = cause
                throw cause
            } finally {
                activeRequests.add(-1, activeAttributes)
                recordBoundary(call, requestContext, failure)
            }
        }
    }

    private fun recordBoundary(call: ApplicationCall, requestContext: RequestContext, failure: Throwable?) {
        val status = statusOf(call, failure)
        if (status.value < 400) {
            return
        }
        val errorType = errorTypeOf(failure, status)
        val attributes = requestAttributes(call, requestContext, status, errorType)
        val level = if (status.value >= 500) EventLevel.ERROR else EventLevel.WARN
        val throwable = failure?.takeIf { it !is DomainException && status.value >= 500 }
        log.event(HTTP_REQUEST_FAILED, *attributes.toTypedArray(), level = level, throwable = throwable)
    }

    private fun statusOf(call: ApplicationCall, failure: Throwable?): HttpStatusCode = when {
        failure is DomainException -> statusMapper.statusFor(failure)
        failure != null -> HttpStatusCode.InternalServerError
        else -> call.response.status() ?: HttpStatusCode.OK
    }

    private fun errorTypeOf(failure: Throwable?, status: HttpStatusCode): String = when {
        failure is DomainException -> failure.error
        failure != null -> failure::class.java.simpleName
        status == HttpStatusCode.NotFound -> TelemetryAttributes.RESOURCE_NOT_FOUND
        status.value == 400 || status.value == 422 -> TelemetryAttributes.INVALID_ARGUMENT
        else -> TelemetryAttributes.DOMAIN_ERROR
    }

    private fun requestAttributes(
        call: ApplicationCall,
        requestContext: RequestContext,
        status: HttpStatusCode,
        errorType: String,
    ): List<Pair<String, Any?>> = buildList {
        add(TelemetryAttributes.HTTP_REQUEST_METHOD to call.request.httpMethod.value)
        val route = call.attributes.getOrNull(ROUTE_ATTRIBUTE)
        if (route == null) {
            add(TelemetryAttributes.URL_PATH to call.request.path())
        } else {
            add(TelemetryAttributes.HTTP_ROUTE to route)
        }
        add(TelemetryAttributes.HTTP_RESPONSE_STATUS_CODE to status.value)
        add(TelemetryAttributes.ERROR_TYPE to errorType)
        add(TelemetryAttributes.REQUEST_ID to requestContext.requireRequestId())
    }

    private fun activeAttributes(call: ApplicationCall) = Attributes.of(
        OtelAttributeKey.stringKey(TelemetryAttributes.HTTP_REQUEST_METHOD),
        call.request.httpMethod.value,
        OtelAttributeKey.stringKey(TelemetryAttributes.URL_SCHEME),
        call.request.origin.scheme,
    )

    companion object {
        private const val HTTP_REQUEST_FAILED = "http.request.failed"
        private val ROUTE_ATTRIBUTE = AttributeKey<String>("RequestTelemetryRoute")
    }
}
