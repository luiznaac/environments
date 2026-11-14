package dev.agner.template.httpapi.configuration

import dev.agner.template.usecase.commons.DomainException
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.plugins.statuspages.exception
import io.ktor.server.response.respond

fun Application.installDomainExceptionHandler(mapper: DomainExceptionStatusMapper) {
    install(StatusPages) {
        exception<DomainException> { call, cause ->
            call.respond(
                mapper.statusFor(cause),
                ApiError(error = cause.error, message = cause.userMessage, detail = cause.detail),
            )
        }
        exception<Throwable> { call, _ ->
            // The boundary that owns the response: RequestTelemetry already logged the single
            // ERROR record, so consume the failure here instead of letting Ktor's default
            // uncaught-exception logger emit a second one.
            call.respond(HttpStatusCode.InternalServerError)
        }
    }
}

private data class ApiError(
    val error: String,
    val message: String,
    val detail: String,
)
